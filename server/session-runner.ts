import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import type { Goal, StreamJsonEvent, Message, Session, AssistantContentBlock } from '../src/shared/types';
import type { ServerEvent } from '../src/shared/events';
import { createStreamParser } from './stream-parser';
import { processRegistry } from './process-registry';
import type { Killable } from './process-registry';
import logger from './logger';

/**
 * Exhaustive check helper. If this is ever called at runtime, it means
 * a new variant was added to a union but the switch was not updated.
 */
/** Resolves the full path to the claude CLI binary. Caches after first lookup. */
let resolvedClaudePath: string | null = null;
function resolveClaudePath(cliBinary: string): string {
  if (cliBinary !== 'claude') return cliBinary;
  if (resolvedClaudePath) return resolvedClaudePath;
  try {
    resolvedClaudePath = execSync('which claude', { encoding: 'utf-8' }).trim();
    // Convert Git Bash path to Windows path if needed
    if (resolvedClaudePath.startsWith('/c/')) {
      resolvedClaudePath = 'C:/' + resolvedClaudePath.slice(3);
    }
    logger.info({ path: resolvedClaudePath }, 'Resolved claude CLI path');
  } catch {
    resolvedClaudePath = cliBinary; // fallback
  }
  return resolvedClaudePath;
}

function assertNever(x: never): null {
  logger.warn({ value: x }, 'Unhandled union variant');
  return null;
}

// ── Dependency interfaces ────────────────────────────────────────────────────

/**
 * Writes raw stream data to per-session trace files on disk.
 * Binary-fidelity capture of every CLI output line.
 */
export interface TraceWriter {
  /** Appends a raw stdout line to stream.jsonl. */
  appendStream(rawLine: string): void;
  /** Appends a chunk of stderr output. */
  appendStderr(chunk: string): void;
  /** Flushes and closes all trace file handles. */
  close(): Promise<void>;
}

/**
 * Persists messages and sessions to the database.
 */
export interface MessageService {
  /** Creates a session row in the database. */
  createSession(session: Omit<Session, 'stream_event_count' | 'hook_event_count' | 'stderr_bytes' | 'total_cost_usd' | 'total_tokens_in' | 'total_tokens_out' | 'ended_at'>): void;
  /** Saves a message row to the database. */
  saveMessage(message: Message): void;
  /** Marks a session as ended with cost/token stats. */
  endSession(sessionId: string, data: { ended_at: number; total_cost_usd: number; stream_event_count: number }): void;
  /** Increments the stream_event_count for a session. */
  incrementStreamEventCount(sessionId: string): void;
}

/**
 * Updates goal status and session references.
 */
export interface GoalService {
  /** Updates the goal's current_session_id. */
  setCurrentSession(goalId: string, sessionId: string | null): void;
  /** Updates the goal's status. */
  setStatus(goalId: string, status: Goal['status']): void;
}

/** Dependencies injected into SessionRunner. */
export interface SessionRunnerDeps {
  traceWriter: TraceWriter;
  messageService: MessageService;
  goalService: GoalService;
  broadcast: (event: ServerEvent) => void;
}

// ── SessionRunner ────────────────────────────────────────────────────────────

/**
 * Manages a single Claude CLI subprocess for a goal.
 *
 * Spawns `claude` with `--output-format stream-json --input-format stream-json`,
 * parses line-delimited JSON from stdout, routes events to trace writer and
 * message service, and broadcasts WebSocket events.
 *
 * Lifecycle:
 * - `start(prompt)` spawns the CLI and sends the initial prompt
 * - `sendFollowup(prompt)` sends a follow-up prompt to the same session via `--resume`
 * - `interrupt()` sends SIGTERM to the child process
 * - `cleanup()` closes trace files and removes from registry
 */
export class SessionRunner implements Killable {
  private readonly goal: Goal;
  private readonly deps: SessionRunnerDeps;
  private child: ChildProcess | null = null;
  private sessionId: string | null = null;
  private streamEventCount = 0;
  private exited = false;
  private exitResolve: (() => void) | null = null;

  constructor(goal: Goal, deps: SessionRunnerDeps) {
    this.goal = goal;
    this.deps = deps;
  }

  /** Returns the current session ID, or null if not yet started. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Returns whether the subprocess has exited. */
  hasExited(): boolean {
    return this.exited;
  }

  /**
   * Spawns a new Claude CLI subprocess and sends the initial prompt.
   *
   * If a subprocess is already running for this goal (via the registry),
   * it is killed first. Creates a session row, registers in the process
   * registry, and begins streaming.
   *
   * @param initialPrompt - The user prompt to send to the CLI
   * @param cliBinary - Override the CLI binary path (default: 'claude')
   */
  async start(initialPrompt: string, cliBinary = 'claude'): Promise<void> {
    // Kill existing runner for this goal if present
    const existing = processRegistry.get(this.goal.id);
    if (existing) {
      logger.info({ goalId: this.goal.id }, 'Killing existing runner before starting new one');
      await existing.interrupt();
      await existing.cleanup();
      processRegistry.remove(this.goal.id);
    }

    this.sessionId = uuidv4();
    this.streamEventCount = 0;
    this.exited = false;

    // Create session row
    this.deps.messageService.createSession({
      id: this.sessionId,
      goal_id: this.goal.id,
      origin: 'dashboard',
      cwd: this.goal.cwd,
      model: this.goal.model,
      trace_dir: null,
      started_at: Date.now(),
    });

    // Save the user's prompt as a message
    this.deps.messageService.saveMessage({
      id: uuidv4(),
      session_id: this.sessionId,
      role: 'user',
      content: initialPrompt,
      tool_name: null,
      tool_args: null,
      tool_result: null,
      tool_use_id: null,
      token_in: null,
      token_out: null,
      created_at: Date.now(),
    });

    // Broadcast the user message to the UI
    this.deps.broadcast({
      type: 'message:added',
      goal_id: this.goal.id,
      session_id: this.sessionId,
      message: {
        id: uuidv4(),
        session_id: this.sessionId,
        role: 'user',
        content: initialPrompt,
        tool_name: null,
        tool_args: null,
        tool_result: null,
        tool_use_id: null,
        token_in: null,
        token_out: null,
        created_at: Date.now(),
      },
    });

    // Update goal to point to this session
    this.deps.goalService.setCurrentSession(this.goal.id, this.sessionId);
    this.deps.goalService.setStatus(this.goal.id, 'active');

    // Register in process registry
    processRegistry.set(this.goal.id, this);

    // Build spawn args with prompt
    const args = this.buildArgs(this.sessionId, false, initialPrompt);

    logger.info({ goalId: this.goal.id, sessionId: this.sessionId, args }, 'Spawning CLI subprocess');

    this.child = spawn(resolveClaudePath(cliBinary), args, {
      cwd: this.goal.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.setupProcessHandlers();
  }

  /**
   * Sends a follow-up prompt to the existing session by spawning a new
   * subprocess with `--resume`.
   *
   * @param prompt - The follow-up user prompt
   * @param cliBinary - Override the CLI binary path (default: 'claude')
   */
  async sendFollowup(prompt: string, cliBinary = 'claude'): Promise<void> {
    if (!this.sessionId) {
      throw new Error('Cannot send followup: no session started');
    }

    // Kill current subprocess if still running
    if (this.child && !this.exited) {
      await this.interrupt();
    }

    this.exited = false;
    this.streamEventCount = 0;

    // Save the follow-up prompt as a user message
    this.deps.messageService.saveMessage({
      id: uuidv4(),
      session_id: this.sessionId,
      role: 'user',
      content: prompt,
      tool_name: null,
      tool_args: null,
      tool_result: null,
      tool_use_id: null,
      token_in: null,
      token_out: null,
      created_at: Date.now(),
    });

    this.deps.broadcast({
      type: 'message:added',
      goal_id: this.goal.id,
      session_id: this.sessionId,
      message: {
        id: uuidv4(),
        session_id: this.sessionId,
        role: 'user',
        content: prompt,
        tool_name: null,
        tool_args: null,
        tool_result: null,
        tool_use_id: null,
        token_in: null,
        token_out: null,
        created_at: Date.now(),
      },
    });

    const args = this.buildArgs(this.sessionId, true, prompt);

    logger.info({ goalId: this.goal.id, sessionId: this.sessionId }, 'Spawning follow-up CLI subprocess');

    this.child = spawn(resolveClaudePath(cliBinary), args, {
      cwd: this.goal.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.setupProcessHandlers();
  }

  /**
   * Sends SIGTERM to the child process.
   *
   * Returns a promise that resolves when the child exits or after 1 second,
   * whichever comes first.
   */
  async interrupt(): Promise<void> {
    if (!this.child || this.exited) {
      return;
    }

    logger.info({ goalId: this.goal.id, sessionId: this.sessionId }, 'Interrupting subprocess');

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Force kill after 1s if still alive
        if (this.child && !this.exited) {
          logger.warn({ goalId: this.goal.id }, 'Force-killing subprocess after 1s timeout');
          this.child.kill('SIGKILL');
        }
        resolve();
      }, 1000);
      timer.unref();

      this.exitResolve = () => {
        clearTimeout(timer);
        resolve();
      };

      this.child?.kill('SIGTERM');
    });
  }

  /**
   * Closes trace files and removes this runner from the process registry.
   * Should be called after the subprocess has exited.
   */
  async cleanup(): Promise<void> {
    logger.debug({ goalId: this.goal.id, sessionId: this.sessionId }, 'Cleaning up runner');
    await this.deps.traceWriter.close();
    processRegistry.remove(this.goal.id);
  }

  // ── Private methods ──────────────────────────────────────────────────────

  /**
   * Builds the CLI argument array per spec section 7.1.
   */
  private buildArgs(sessionId: string, resume = false, prompt?: string): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (resume) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    if (this.goal.model && this.goal.model !== 'default') {
      args.push('--model', this.goal.model);
    }

    // Pass prompt directly via -p flag (non-interactive mode)
    if (prompt) {
      args.push('-p', prompt);
    }

    return args;
  }

  /**
   * Sets up stdout/stderr/exit handlers on the child process.
   */
  private setupProcessHandlers(): void {
    const child = this.child;
    if (!child) return;

    // Parse stdout via stream parser
    if (child.stdout) {
      createStreamParser(child.stdout, {
        onRawLine: (line: string) => {
          this.deps.traceWriter.appendStream(line);
          this.streamEventCount++;
          if (this.sessionId) {
            this.deps.messageService.incrementStreamEventCount(this.sessionId);
          }
        },
        onEvent: (event: StreamJsonEvent) => {
          this.handleEvent(event);
        },
        onParseError: (error: string, rawLine: string) => {
          logger.warn({ goalId: this.goal.id, error, rawLine: rawLine.substring(0, 200) }, 'Stream parse error');
        },
      });
    }

    // Capture stderr
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        this.deps.traceWriter.appendStderr(chunk.toString());
      });
    }

    // Handle process exit
    child.on('exit', (code: number | null, signal: string | null) => {
      this.exited = true;
      logger.info({ goalId: this.goal.id, sessionId: this.sessionId, code, signal }, 'CLI subprocess exited');

      if (code !== null && code !== 0) {
        // Non-zero exit: mark goal as error
        this.deps.goalService.setStatus(this.goal.id, 'waiting');
        this.deps.broadcast({
          type: 'subprocess:error',
          goal_id: this.goal.id,
          error: `CLI exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`,
        });
      }

      if (this.exitResolve) {
        this.exitResolve();
        this.exitResolve = null;
      }
    });

    child.on('error', (err: Error) => {
      this.exited = true;
      logger.error({ goalId: this.goal.id, err }, 'CLI subprocess error');

      this.deps.goalService.setStatus(this.goal.id, 'waiting');
      this.deps.broadcast({
        type: 'subprocess:error',
        goal_id: this.goal.id,
        error: `Subprocess error: ${err.message}`,
      });

      if (this.exitResolve) {
        this.exitResolve();
        this.exitResolve = null;
      }
    });
  }

  /**
   * Routes a parsed StreamJsonEvent to the appropriate handlers.
   */
  private handleEvent(event: StreamJsonEvent): void {
    switch (event.type) {
      case 'system':
        this.handleSystemEvent(event);
        break;
      case 'assistant':
        this.handleAssistantEvent(event);
        break;
      case 'user':
        this.handleUserEvent(event);
        break;
      case 'result':
        this.handleResultEvent(event);
        break;
    }
  }

  /**
   * Handles system events (init, compact_boundary).
   */
  private handleSystemEvent(event: StreamJsonEvent): void {
    if (event.type !== 'system') return;

    if (event.subtype === 'init') {
      logger.info({ sessionId: event.session_id, model: event.model }, 'CLI session initialized');
      // Session row already created in start() -- the init event confirms it
    }
    // compact_boundary events are traced but don't produce messages
  }

  /**
   * Handles assistant events by extracting content blocks into messages.
   */
  private handleAssistantEvent(event: StreamJsonEvent): void {
    if (event.type !== 'assistant') return;

    for (const block of event.message.content) {
      const message = this.contentBlockToMessage(block);
      if (message) {
        this.deps.messageService.saveMessage(message);
        this.deps.broadcast({
          type: 'message:added',
          goal_id: this.goal.id,
          session_id: this.sessionId ?? '',
          message,
        });
      }
    }
  }

  /**
   * Handles user events (tool results) by creating message rows.
   */
  private handleUserEvent(event: StreamJsonEvent): void {
    if (event.type !== 'user') return;

    for (const block of event.message.content) {
      if (block.type === 'tool_result') {
        const message: Message = {
          id: uuidv4(),
          session_id: this.sessionId ?? '',
          role: 'tool_result',
          content: block.content.length > 4000 ? block.content.substring(0, 4000) : block.content,
          tool_name: null,
          tool_args: null,
          tool_result: block.content.length > 4000 ? block.content.substring(0, 4000) : block.content,
          tool_use_id: block.tool_use_id,
          token_in: null,
          token_out: null,
          created_at: Date.now(),
        };

        this.deps.messageService.saveMessage(message);
        this.deps.broadcast({
          type: 'message:added',
          goal_id: this.goal.id,
          session_id: this.sessionId ?? '',
          message,
        });
      }
    }
  }

  /**
   * Handles result events (end of turn).
   */
  private handleResultEvent(event: StreamJsonEvent): void {
    if (event.type !== 'result') return;

    logger.info({
      goalId: this.goal.id,
      sessionId: event.session_id,
      cost: event.total_cost_usd,
      turns: event.num_turns,
    }, 'CLI turn completed');

    // End the session
    if (this.sessionId) {
      this.deps.messageService.endSession(this.sessionId, {
        ended_at: Date.now(),
        total_cost_usd: event.total_cost_usd,
        stream_event_count: this.streamEventCount,
      });
    }

    // Move goal to waiting (needs user input for next turn)
    this.deps.goalService.setStatus(this.goal.id, 'waiting');

    this.deps.broadcast({
      type: 'session:ended',
      id: this.sessionId ?? event.session_id,
    });

    this.deps.broadcast({
      type: 'goal:status',
      id: this.goal.id,
      status: 'waiting',
      current_session_id: this.sessionId,
    });
  }

  /**
   * Converts an AssistantContentBlock into a Message row.
   * Text blocks become assistant messages, tool_use blocks become tool_use messages,
   * and thinking blocks become assistant messages with a [thinking] prefix.
   */
  private contentBlockToMessage(block: AssistantContentBlock): Message | null {
    switch (block.type) {
      case 'text':
        return {
          id: uuidv4(),
          session_id: this.sessionId ?? '',
          role: 'assistant',
          content: block.text,
          tool_name: null,
          tool_args: null,
          tool_result: null,
          tool_use_id: null,
          token_in: null,
          token_out: null,
          created_at: Date.now(),
        };

      case 'tool_use':
        return {
          id: uuidv4(),
          session_id: this.sessionId ?? '',
          role: 'tool_use',
          content: null,
          tool_name: block.name,
          tool_args: JSON.stringify(block.input),
          tool_result: null,
          tool_use_id: block.id,
          token_in: null,
          token_out: null,
          created_at: Date.now(),
        };

      case 'thinking':
        return {
          id: uuidv4(),
          session_id: this.sessionId ?? '',
          role: 'assistant',
          content: `[thinking] ${block.thinking}`,
          tool_name: null,
          tool_args: null,
          tool_result: null,
          tool_use_id: null,
          token_in: null,
          token_out: null,
          created_at: Date.now(),
        };

      default:
        // Exhaustive check -- if new block types are added to the union,
        // TypeScript will flag this as an error at compile time.
        return assertNever(block);
    }
  }

  /**
   * Writes a user prompt to the child's stdin in stream-json format.
   */
  // @ts-expect-error reserved for stream-json input mode (v1.1)
  private sendStdinMessage(prompt: string): void {
    if (!this.child?.stdin) {
      logger.error({ goalId: this.goal.id }, 'Cannot write to stdin: no child process');
      return;
    }

    if (this.exited) {
      logger.warn({ goalId: this.goal.id }, 'Cannot write to stdin: process already exited');
      return;
    }

    const stdinPayload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    });

    try {
      this.child.stdin.write(stdinPayload + '\n');
      this.child.stdin.end();
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPIPE') {
        logger.warn({ goalId: this.goal.id }, 'EPIPE on stdin write — process likely exited');
      } else {
        logger.error({ goalId: this.goal.id, err }, 'Error writing to stdin');
      }
    }
  }
}
