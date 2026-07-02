// src/shared/agents/types.ts
//
// Framework-free types shared by client and server for the multi-provider
// agent abstraction. No runtime logic — the test is a compile-time usage
// assertion.

// ModelPricing is owned by the model-registry (the lowest-level primitive);
// re-export it here so adapter/usage code can import pricing from one place.
export type { ModelPricing } from './model-registry';

/** One entry in the model picker. `value` is provider-qualified (e.g. 'opus', 'antigravity'). */
export interface ModelOption {
  value: string;
  label: string;
}

/** The claude-deck MCP server, described provider-agnostically. Each adapter serializes it itself. */
export interface McpServerDescriptor {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Everything an adapter needs to launch a session. */
export interface SpawnContext {
  goalId: string;
  model: string;
  cwd: string;
  permissionMode: 'autonomous' | 'supervised';
  mcpServer: McpServerDescriptor | null;
  agentType?: string | null | undefined;
}

/** Per-model token totals within a session. */
export interface RawModelUsage {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
}

/**
 * Session usage: top-level fields are the rolled-up session totals (back-compat);
 * `byModel` carries the per-model rows (single-model sessions → 1-element array).
 */
export interface RawUsage extends RawModelUsage {
  byModel: RawModelUsage[];
}

/** What an adapter's CLI can actually do; the UI greys out unsupported affordances. */
export interface AgentCapabilities {
  canObserveHooks: boolean;
  canResume: boolean;
  canMcp: boolean;
  canApprove: boolean;
  canStream: boolean;
}

/** Client-facing catalog entry for one provider (no server-only methods). */
export interface AgentCatalogEntry {
  id: string;
  label: string;
  enabled: boolean;
  models: ModelOption[];
  capabilities: AgentCapabilities;
  /** Optional hint shown in Settings when enabling (e.g. how to authenticate). */
  authHint?: string;
}
