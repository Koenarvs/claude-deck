// server/agents/agent-adapter.ts
//
// The provider abstraction. One adapter instance per LLM CLI. Everything that
// varies per provider lives behind this interface, grouped by lifecycle.
// Interface-only — verified by its implementers (ClaudeAdapter, MockAdapter).

import type {
  ModelOption,
  SpawnContext,
  RawUsage,
  ModelPricing,
  AgentCapabilities,
} from '../../src/shared/agents/types';

/** How an adapter delivers the initial prompt to a freshly-spawned PTY. */
export type PromptStrategy =
  | { kind: 'idle'; idleMs: number }
  | { kind: 'regex'; promptRegex: RegExp; idleMs: number }
  | { kind: 'flag' };

export interface AgentAdapter {
  // ── Identity & catalog ──────────────────────────────────────────────
  readonly id: string;
  readonly label: string;
  readonly models: ModelOption[];
  readonly capabilities: AgentCapabilities;
  readonly authHint?: string;

  // ── Launch ──────────────────────────────────────────────────────────
  resolveBinary(): string;
  buildStartArgs(ctx: SpawnContext): string[];
  buildResumeArgs(sessionId: string, ctx: SpawnContext): string[];
  readonly promptStrategy: PromptStrategy;

  /**
   * Phase 3: point the CLI's native context file (CLAUDE.md / AGENTS.md /
   * GEMINI.md) at the shared goal docs. Claude's impl writes/links CLAUDE.md,
   * or no-ops if already present.
   */
  prepareContext(ctx: SpawnContext): void;

  // ── Observe (hooks) ─────────────────────────────────────────────────
  installHooks(): Promise<void>;
  uninstallHooks(): Promise<void>;
  hooksInstalled(): Promise<boolean>;

  // ── Account (usage / analytics) ─────────────────────────────────────
  locateSessionLog(sessionId: string): string | null;
  parseUsage(logPath: string): RawUsage;
  listSessionLogs(sinceMs: number): string[];
  pricingFor(model: string): ModelPricing;
  contextWindowFor(model: string, currentTokens: number): number;
}
