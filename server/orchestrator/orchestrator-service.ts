import type { ServerEvent } from '../../src/shared/events';
import type { OrchestratorTrigger, OrchestratorChannel } from '../../src/shared/orchestrator';
import type { OrchestratorStateService } from '../services/orchestrator-state-service';
import type { OrchestratorMessageService } from '../services/orchestrator-message-service';
import type { MemoryStore } from './memory-store';
import type { BrainStreamEvent } from './brain-provider';
import type { BrainResult } from './brain-runner';
import { buildContextPrompt } from './context-bundle';
import logger from '../logger';

export type RunFn = (
  prompt: string,
  onEvent: (e: BrainStreamEvent) => void,
) => Promise<BrainResult>;

export interface OrchestratorServiceDeps {
  stateService: OrchestratorStateService;
  messageService: OrchestratorMessageService;
  memoryStore: Pick<MemoryStore, 'read' | 'write'>;
  snapshotMd: () => string;
  mcpConfigJson: () => string;
  runFn: RunFn;
  broadcast: (event: ServerEvent) => void;
}

const RECENT_TURNS = 10;

/**
 * The orchestrator dispatcher. Owns a serialized trigger queue and a lifecycle state machine
 * (idle → waking → active → cooling → idle). Each trigger assembles a context bundle, runs the
 * headless brain via `runFn`, mirrors output to the chat thread + WS, and persists the brain's
 * updated memory on a clean run.
 */
export class OrchestratorService {
  private readonly deps: OrchestratorServiceDeps;
  private queue: OrchestratorTrigger[] = [];
  private processing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private drainWaiters: Array<() => void> = [];

  constructor(deps: OrchestratorServiceDeps) {
    this.deps = deps;
  }

  /** Enqueues a trigger and kicks the queue. No-op (logs) when disabled. */
  async trigger(t: OrchestratorTrigger): Promise<void> {
    if (!this.deps.stateService.get().config.enabled) {
      logger.debug({ kind: t.kind }, 'Orchestrator trigger ignored (disabled)');
      return;
    }
    this.queue.push(t);
    void this.pump();
  }

  /** Resolves once the queue is empty and no run is in flight (test/shutdown helper). */
  drain(): Promise<void> {
    if (!this.processing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    try {
      while (this.queue.length > 0) {
        const t = this.queue.shift()!;
        await this.handle(t);
      }
    } finally {
      this.processing = false;
      this.startIdleTimer();
      const waiters = this.drainWaiters;
      this.drainWaiters = [];
      for (const w of waiters) w();
    }
  }

  private async handle(t: OrchestratorTrigger): Promise<void> {
    const now = Date.now();
    const { stateService, messageService, memoryStore, broadcast } = this.deps;
    const config = stateService.get().config;

    // Record the owner's message as a turn (so the thread shows it).
    if (t.kind === 'owner_message' && t.text) {
      const channel: OrchestratorChannel = t.channel ?? 'app';
      const ownerMsg = messageService.append({
        role: 'owner',
        channel,
        content: t.text,
        tool_calls_json: null,
        trigger_kind: 'owner_message',
      });
      broadcast({ type: 'orchestrator:message', message: ownerMsg });
    }

    stateService.setStatus('waking', now);
    broadcast({ type: 'orchestrator:status', status: 'waking' });

    const prompt = buildContextPrompt({
      personaName: config.persona_name,
      memory: memoryStore.read(),
      snapshotMd: this.deps.snapshotMd(),
      recentTurns: messageService.recent(RECENT_TURNS).map((m) => ({ role: m.role, content: m.content })),
      trigger: t,
    });

    stateService.setStatus('active', Date.now());
    broadcast({ type: 'orchestrator:status', status: 'active' });

    const toolCalls: Array<{ tool: string; summary: string }> = [];
    let result: BrainResult;
    try {
      result = await this.deps.runFn(prompt, (e) => {
        if (e.kind === 'tool') {
          toolCalls.push({ tool: e.tool, summary: e.summary });
          broadcast({ type: 'orchestrator:tool', tool: e.tool, summary: e.summary });
        }
      });
    } catch (err) {
      logger.error({ err, kind: t.kind }, 'Orchestrator run threw');
      const sysMsg = messageService.append({
        role: 'system',
        channel: 'internal',
        content: `Run failed: ${err instanceof Error ? err.message : String(err)}`,
        tool_calls_json: null,
        trigger_kind: t.kind,
      });
      broadcast({ type: 'orchestrator:message', message: sysMsg });
      return;
    }

    // Strip the memory block from the visible reply.
    const visible = result.fullText.replace(/<memory-update>[\s\S]*?<\/memory-update>/g, '').trim();
    const reply = messageService.append({
      role: 'orchestrator',
      channel: 'app',
      content: visible.length ? visible : result.aborted ? '(run aborted — no output)' : '(no reply)',
      tool_calls_json: toolCalls.length ? JSON.stringify(toolCalls) : null,
      trigger_kind: t.kind,
    });
    broadcast({ type: 'orchestrator:message', message: reply });

    // Persist updated memory only on a clean run.
    if (result.ok && result.memory) {
      memoryStore.write(result.memory);
    }
  }

  /**
   * Governance guard for orchestrator-spawned children. Consulted by the wiring before
   * permitting a child-spawning MCP action. Returns allow + reason.
   */
  canSpawnChild(ctx: { liveChildren: number; depth: number }): { allowed: boolean; reason: string } {
    const { max_concurrent_children, max_depth } = this.deps.stateService.get().config;
    if (ctx.depth >= max_depth) {
      return { allowed: false, reason: `orchestration depth cap reached (max_depth=${max_depth})` };
    }
    if (ctx.liveChildren >= max_concurrent_children) {
      return {
        allowed: false,
        reason: `concurrent children cap reached (max_concurrent_children=${max_concurrent_children})`,
      };
    }
    return { allowed: true, reason: 'ok' };
  }

  private startIdleTimer(): void {
    const { idle_timeout_ms } = this.deps.stateService.get().config;
    this.deps.stateService.setStatus('cooling', Date.now());
    this.deps.broadcast({ type: 'orchestrator:status', status: 'cooling' });
    this.idleTimer = setTimeout(() => {
      this.deps.stateService.setStatus('idle', Date.now());
      this.deps.broadcast({ type: 'orchestrator:status', status: 'idle' });
    }, idle_timeout_ms);
    this.idleTimer.unref?.();
  }

  /** Clears timers on shutdown. */
  shutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.deps.stateService.setStatus('idle', Date.now());
  }
}
