import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Goal } from '../src/shared/types';
import type { ServerEvent } from '../src/shared/events';
import type { Killable } from './process-registry';
import { processRegistry } from './process-registry';
import { TraceWriter } from './trace-writer';
import logger from './logger';
import type { AgentAdapter } from './agents/agent-adapter';
import type { SpawnContext, McpServerDescriptor } from '../src/shared/agents/types';

// On Windows with Git Bash, process.execPath points to Git's bundled node stub
// which doesn't exist as a real binary. node-pty's conpty agent needs the real
// node.exe to track child PIDs. Find and cache the real path.
let realNodePath: string | null = null;
function findRealNodePath(): string {
  if (realNodePath) return realNodePath;
  if (process.platform !== 'win32') {
    realNodePath = process.execPath;
    return realNodePath;
  }
  if (existsSync(process.execPath)) {
    realNodePath = process.execPath;
    return realNodePath;
  }
  try {
    const paths = execSync('where node', { encoding: 'utf-8' }).trim().split(/\r?\n/);
    for (const p of paths) {
      if (existsSync(p.trim()) && !p.includes('Git')) {
        realNodePath = p.trim();
        logger.info({ realNodePath }, 'PTY: Found real node.exe path');
        return realNodePath;
      }
    }
  } catch { /* ignore */ }
  realNodePath = process.execPath;
  return realNodePath;
}

interface PtyManagerOptions {
  broadcast: (event: ServerEvent) => void;
  onExit?: (goalId: string, exitCode: number) => void;
  onReady?: () => void;
  /** When set, the session's raw PTY stream + exit meta are written here. */
  traceDir?: string;
}

export class PtyManager implements Killable {
  private terminal: pty.IPty | null = null;
  private readonly goalId: string;
  private readonly goal: Goal;
  private readonly adapter: AgentAdapter;
  private readonly broadcast: (event: ServerEvent) => void;
  private readonly onExitCallback: ((goalId: string, exitCode: number) => void) | undefined;
  private readonly onReadyCallback: (() => void) | undefined;
  private readonly traceDir: string | undefined;
  private traceWriter: TraceWriter | null = null;
  private exited = false;

  constructor(goal: Goal, adapter: AgentAdapter, options: PtyManagerOptions) {
    this.goal = goal;
    this.goalId = goal.id;
    this.adapter = adapter;
    this.broadcast = options.broadcast;
    this.onExitCallback = options.onExit;
    this.onReadyCallback = options.onReady;
    this.traceDir = options.traceDir;
  }

  /** Lazily create the per-session trace writer (no-op when no trace dir is set). */
  private initTrace(): void {
    if (this.traceDir && !this.traceWriter) {
      this.traceWriter = new TraceWriter(this.goalId, this.traceDir);
    }
  }

  /** Write exit meta + close the trace writer (fire-and-forget; errors logged). */
  private finishTrace(exitCode: number): void {
    const writer = this.traceWriter;
    if (!writer) return;
    void (async () => {
      try {
        await writer.writeMeta({ session_id: this.goalId, exitCode, ended_at: Date.now() });
        await writer.close();
      } catch (err) {
        logger.error({ err, goalId: this.goalId }, 'TraceWriter close failed');
      }
    })();
  }

  /** The spawn context for this goal's session. */
  private spawnContext(): SpawnContext {
    return {
      goalId: this.goalId,
      model: this.goal.model ?? 'default',
      cwd: this.goal.cwd,
      permissionMode: this.goal.permission_mode,
      mcpServer: this.buildMcpDescriptor(),
    };
  }

  /** Pure: the launch argv the adapter builds for a new session. */
  buildLaunchArgs(): string[] {
    return this.adapter.buildStartArgs(this.spawnContext());
  }

  start(initialPrompt?: string): void {
    const claudePath = this.adapter.resolveBinary();
    const args = this.buildLaunchArgs();
    this.initTrace();

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env['TERM'] = 'xterm-256color';

    logger.info(
      { goalId: this.goalId, claudePath, args, cwd: this.goal.cwd },
      'PTY: Spawning claude',
    );

    try {
      // Temporarily fix process.execPath for conpty agent (it uses this to find node)
      const origExecPath = process.execPath;
      const realNode = findRealNodePath();
      if (realNode !== origExecPath) {
        Object.defineProperty(process, 'execPath', { value: realNode, writable: true, configurable: true });
      }

      this.terminal = pty.spawn(claudePath, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: this.goal.cwd,
        env,
      });

      // Restore original execPath
      if (realNode !== origExecPath) {
        Object.defineProperty(process, 'execPath', { value: origExecPath, writable: true, configurable: true });
      }
    } catch (err) {
      logger.error({ err, goalId: this.goalId }, 'PTY: Failed to spawn');
      this.exited = true;
      this.broadcast({
        type: 'terminal:exited',
        goal_id: this.goalId,
        exitCode: 1,
      });
      return;
    }

    // Idle detection determines when the PTY is ready for input.
    // When ready: send the initial prompt (if any), then fire onReady.
    const pendingPrompt = initialPrompt ?? '';
    const hasPrompt = !!pendingPrompt;
    let sessionReady = false;

    const markReady = (method: string) => {
      if (sessionReady) return;
      sessionReady = true;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }

      if (hasPrompt) {
        setTimeout(() => {
          this.write(pendingPrompt);
          setTimeout(() => {
            this.write('\r');
            logger.info({ goalId: this.goalId, promptLength: pendingPrompt.length, method }, 'PTY: Sent initial prompt');
            this.onReadyCallback?.();
          }, 200);
        }, 500);
      } else {
        this.onReadyCallback?.();
      }
    };

    // Prompt-readiness detection is driven by the adapter's promptStrategy
    // (idle delay + optional prompt regex), with a hard 45s fallback.
    const strategy = this.adapter.promptStrategy;
    const idleMs = strategy.kind === 'flag' ? 0 : strategy.idleMs;
    const promptRegex = strategy.kind === 'regex' ? strategy.promptRegex : null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    fallbackTimer = setTimeout(() => markReady('timeout-fallback'), 45_000);

    this.terminal.onData((data: string) => {
      this.broadcast({
        type: 'terminal:data',
        goal_id: this.goalId,
        data,
      });
      this.traceWriter?.appendStream(data);

      if (!sessionReady) {
        if (idleMs > 0) {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => markReady('idle'), idleMs);
        }
        if (promptRegex) {
          const clean = data.replace(/\x1b[^\x1b]*/g, '');
          if (promptRegex.test(clean)) {
            markReady('regex');
          }
        }
      }
    });

    this.terminal.onExit(({ exitCode }) => {
      this.exited = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      logger.info({ goalId: this.goalId, exitCode }, 'PTY: Process exited');
      this.broadcast({
        type: 'terminal:exited',
        goal_id: this.goalId,
        exitCode,
      });
      this.finishTrace(exitCode);
      processRegistry.remove(this.goalId);
      this.onExitCallback?.(this.goalId, exitCode);
    });

    this.broadcast({
      type: 'terminal:started',
      goal_id: this.goalId,
    });
  }

  resume(sessionId: string): void {
    const claudePath = this.adapter.resolveBinary();
    const args = this.adapter.buildResumeArgs(sessionId, this.spawnContext());
    this.initTrace();

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env['TERM'] = 'xterm-256color';

    logger.info(
      { goalId: this.goalId, sessionId, claudePath },
      'PTY: Resuming session',
    );

    const origExecPath = process.execPath;
    const realNode = findRealNodePath();
    if (realNode !== origExecPath) {
      Object.defineProperty(process, 'execPath', { value: realNode, writable: true, configurable: true });
    }

    this.terminal = pty.spawn(claudePath, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: this.goal.cwd,
      env,
    });

    if (realNode !== origExecPath) {
      Object.defineProperty(process, 'execPath', { value: origExecPath, writable: true, configurable: true });
    }

    // Idle detection for resumed sessions — fire onReady when output settles
    let readyFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const fireReady = (method: string) => {
      if (readyFired) return;
      readyFired = true;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
      logger.info({ goalId: this.goalId, method }, 'PTY: Resumed session ready');
      this.onReadyCallback?.();
    };

    const strategy = this.adapter.promptStrategy;
    const idleMs = strategy.kind === 'flag' ? 0 : strategy.idleMs;
    const promptRegex = strategy.kind === 'regex' ? strategy.promptRegex : null;
    fallbackTimer = setTimeout(() => fireReady('timeout-fallback'), 45_000);

    this.terminal.onData((data: string) => {
      this.broadcast({
        type: 'terminal:data',
        goal_id: this.goalId,
        data,
      });
      this.traceWriter?.appendStream(data);

      if (!readyFired) {
        if (idleMs > 0) {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => fireReady('idle'), idleMs);
        }
        if (promptRegex) {
          const clean = data.replace(/\x1b[^\x1b]*/g, '');
          if (promptRegex.test(clean)) {
            fireReady('regex');
          }
        }
      }
    });

    this.terminal.onExit(({ exitCode }) => {
      this.exited = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
      logger.info({ goalId: this.goalId, exitCode }, 'PTY: Resumed process exited');
      this.broadcast({
        type: 'terminal:exited',
        goal_id: this.goalId,
        exitCode,
      });
      this.finishTrace(exitCode);
      processRegistry.remove(this.goalId);
      this.onExitCallback?.(this.goalId, exitCode);
    });

    this.broadcast({
      type: 'terminal:started',
      goal_id: this.goalId,
    });
  }

  write(data: string): void {
    if (this.terminal && !this.exited) {
      this.terminal.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.terminal && !this.exited) {
      try {
        this.terminal.resize(cols, rows);
      } catch (err) {
        logger.warn({ err, goalId: this.goalId }, 'PTY: Resize failed');
      }
    }
  }

  isAlive(): boolean {
    return this.terminal !== null && !this.exited;
  }

  async interrupt(): Promise<void> {
    if (this.terminal && !this.exited) {
      logger.info({ goalId: this.goalId }, 'PTY: Killing process');
      this.terminal.kill();
    }
  }

  async cleanup(): Promise<void> {
    await this.traceWriter?.close();
    this.terminal = null;
  }

  /**
   * Builds the structured MCP descriptor for this goal's session. The adapter
   * serializes it into its CLI-specific form (Claude → inline JSON + --mcp-config).
   * The env shape is preserved exactly so the serialized output is unchanged.
   */
  private buildMcpDescriptor(): McpServerDescriptor | null {
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const mcpEntry = path.resolve(__dirname, '..', 'mcp', 'dist', 'index.js');
      const port = process.env['PORT'] ?? '4100';
      const baseUrl = `http://127.0.0.1:${port}`;

      const env: Record<string, string> = {
        CLAUDE_DECK_URL: baseUrl,
        CLAUDE_DECK_GOAL_ID: this.goalId,
      };
      // Pass the shared secret so in-session MCP tools authenticate back to /api.
      const token = process.env['CLAUDE_DECK_TOKEN'];
      if (token && token.trim().length > 0) {
        env['CLAUDE_DECK_TOKEN'] = token;
      }

      return { name: 'claude-deck', command: 'node', args: [mcpEntry], env };
    } catch (err) {
      logger.warn({ err }, 'PTY: Failed to build MCP descriptor');
      return null;
    }
  }
}
