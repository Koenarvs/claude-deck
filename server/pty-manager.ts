import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import type { Goal } from '../src/shared/types';
import type { ServerEvent } from '../src/shared/events';
import type { Killable } from './process-registry';
import { processRegistry } from './process-registry';
import logger from './logger';

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

let resolvedClaudePath: string | null = null;
function resolveClaudePath(): string {
  if (resolvedClaudePath) return resolvedClaudePath;
  try {
    resolvedClaudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
    // Convert Git Bash path to Windows path
    if (resolvedClaudePath.startsWith('/c/')) {
      resolvedClaudePath = 'C:/' + resolvedClaudePath.slice(3);
    }
    // node-pty on Windows needs the .exe extension
    if (process.platform === 'win32' && !resolvedClaudePath.endsWith('.exe')) {
      resolvedClaudePath += '.exe';
    }
    logger.info({ path: resolvedClaudePath }, 'PTY: Resolved claude CLI path');
  } catch {
    resolvedClaudePath = process.platform === 'win32' ? 'claude.exe' : 'claude';
  }
  return resolvedClaudePath;
}

interface PtyManagerOptions {
  broadcast: (event: ServerEvent) => void;
  onExit?: (goalId: string, exitCode: number) => void;
}

export class PtyManager implements Killable {
  private terminal: pty.IPty | null = null;
  private readonly goalId: string;
  private readonly sessionId: string;
  private readonly goal: Goal;
  private readonly broadcast: (event: ServerEvent) => void;
  private readonly onExitCallback: ((goalId: string, exitCode: number) => void) | undefined;
  private exited = false;

  constructor(goal: Goal, options: PtyManagerOptions) {
    this.goal = goal;
    this.goalId = goal.id;
    this.sessionId = uuidv4();
    this.broadcast = options.broadcast;
    this.onExitCallback = options.onExit;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  start(initialPrompt?: string): void {
    const claudePath = resolveClaudePath();
    const args: string[] = [];
    if (this.goal.permission_mode === 'autonomous') {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--session-id', this.sessionId);
    if (this.goal.model && this.goal.model !== 'default') {
      args.push('--model', this.goal.model);
    }

    // Inject Claude Deck MCP server so goal sessions can orchestrate other goals
    const mcpConfig = this.buildMcpConfig();
    if (mcpConfig) {
      args.push('--mcp-config', mcpConfig);
    }

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

    // For autonomous goals, auto-accept the --dangerously-skip-permissions warning
    let acceptSent = false;
    const isAutonomous = this.goal.permission_mode === 'autonomous';

    this.terminal.onData((data: string) => {
      this.broadcast({
        type: 'terminal:data',
        goal_id: this.goalId,
        data,
      });

      // Detect the bypass permissions warning and auto-accept for autonomous goals
      if (isAutonomous && !acceptSent && data.includes('Yes, I accept')) {
        acceptSent = true;
        // Down arrow to select "2. Yes, I accept", then Enter
        setTimeout(() => {
          this.write('\x1b[B'); // down arrow
          setTimeout(() => {
            this.write('\r');   // enter
            logger.info({ goalId: this.goalId }, 'PTY: Auto-accepted bypass permissions warning');
          }, 100);
        }, 200);
      }
    });

    this.terminal.onExit(({ exitCode }) => {
      this.exited = true;
      logger.info({ goalId: this.goalId, exitCode }, 'PTY: Process exited');
      this.broadcast({
        type: 'terminal:exited',
        goal_id: this.goalId,
        exitCode,
      });
      processRegistry.remove(this.goalId);
      this.onExitCallback?.(this.goalId, exitCode);
    });

    this.broadcast({
      type: 'terminal:started',
      goal_id: this.goalId,
    });

    if (initialPrompt) {
      setTimeout(() => {
        this.write(initialPrompt + '\n');
      }, 500);
    }
  }

  resume(sessionId: string): void {
    const claudePath = resolveClaudePath();

    const args = ['--resume', sessionId];
    if (this.goal.permission_mode === 'autonomous') {
      args.push('--dangerously-skip-permissions');
    }

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

    let resumeAcceptSent = false;
    const isAutonomousResume = this.goal.permission_mode === 'autonomous';

    this.terminal.onData((data: string) => {
      this.broadcast({
        type: 'terminal:data',
        goal_id: this.goalId,
        data,
      });

      if (isAutonomousResume && !resumeAcceptSent && data.includes('Yes, I accept')) {
        resumeAcceptSent = true;
        setTimeout(() => {
          this.write('\x1b[B');
          setTimeout(() => {
            this.write('\r');
            logger.info({ goalId: this.goalId }, 'PTY: Auto-accepted bypass permissions warning (resume)');
          }, 100);
        }, 200);
      }
    });

    this.terminal.onExit(({ exitCode }) => {
      this.exited = true;
      logger.info({ goalId: this.goalId, exitCode }, 'PTY: Resumed process exited');
      this.broadcast({
        type: 'terminal:exited',
        goal_id: this.goalId,
        exitCode,
      });
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
    this.terminal = null;
  }

  private buildMcpConfig(): string | null {
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const mcpEntry = path.resolve(__dirname, '..', 'mcp', 'dist', 'index.js');
      const port = process.env['PORT'] ?? '4100';
      const baseUrl = `http://127.0.0.1:${port}`;

      return JSON.stringify({
        mcpServers: {
          'claude-deck': {
            command: 'node',
            args: [mcpEntry],
            env: { CLAUDE_DECK_URL: baseUrl },
          },
        },
      });
    } catch (err) {
      logger.warn({ err }, 'PTY: Failed to build MCP config');
      return null;
    }
  }
}
