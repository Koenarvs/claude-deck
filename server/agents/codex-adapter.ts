// server/agents/codex-adapter.ts
//
// AgentAdapter for the OpenAI Codex CLI (`codex`), driven against the user's
// ChatGPT subscription seat — NO OpenAI API key, ever (Decision 6). Headless
// entry is `codex exec "<prompt>"`; the prompt is a positional launch arg, so
// promptStrategy is { kind: 'flag' } (PtyManager appends the prompt — this
// adapter's argv excludes it). Capabilities are declared honestly: Codex has no
// Claude-style hook system and no interceptable approval round-trip in headless
// exec, so canObserveHooks/canApprove are false; analytics come from the
// persisted rollout JSONL, not live hook events.
//
// See docs/superpowers/plans/2026-06-09-codex-adapter.md for the discovery-spike
// findings. Items the real `codex` CLI must still confirm are marked `ASSUMED:`.
//
// The plan factors usage parsing into a separate codex-usage-service; that file
// is a sibling deliverable not yet present, so the rollout-JSONL primitives are
// inlined here to keep this adapter self-contained.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentAdapter, PromptStrategy } from './agent-adapter';
import type {
  ModelOption,
  SpawnContext,
  RawUsage,
  RawModelUsage,
  ModelPricing,
  AgentCapabilities,
} from '../../src/shared/agents/types';
import { MODEL_REGISTRY, resolveModel } from '../../src/shared/agents/model-registry';
import logger from '../logger';

let cachedPath: string | null = null;

/**
 * Picks the spawnable codex binary from `where`/`which` output. On Windows npm
 * installs codex as a `.cmd` shim (plus an extensionless git-bash script and a
 * `.ps1`) — there is NO `codex.exe`. node-pty can spawn `.cmd`/`.exe` but not the
 * bare extensionless shim, so we must select `.cmd` and never append `.exe`.
 * Prefers a real `.exe`, then `.cmd`, then a `.cmd` sibling of a bare path.
 * Exported for testing.
 */
export function pickCodexBinary(whichOutput: string, platform: NodeJS.Platform): string {
  const lines = whichOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('/c/') ? 'C:/' + l.slice(3) : l));
  if (lines.length === 0) return platform === 'win32' ? 'codex.cmd' : 'codex';
  if (platform !== 'win32') return lines[0]!;
  const exe = lines.find((l) => /\.exe$/i.test(l));
  if (exe) return exe;
  const cmd = lines.find((l) => /\.cmd$/i.test(l));
  if (cmd) return cmd;
  const bare = lines.find((l) => !/\.[a-z0-9]+$/i.test(l));
  if (bare) return bare + '.cmd';
  return lines[0]!;
}

// Default rollout transcript store: $CODEX_HOME/sessions (defaults to ~/.codex).
// ASSUMED: layout is sessions/YYYY/MM/DD/rollout-*.jsonl (per plan; confirm vs real CLI).
const CODEX_SESSIONS_DIR = join(
  process.env['CODEX_HOME'] ?? join(homedir(), '.codex'),
  'sessions',
);

function emptyModelRow(model: string | null): RawModelUsage {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messageCount: 0,
  };
}

/**
 * Parse one Codex rollout JSONL into per-model + rolled-up RawUsage.
 * Never throws — a missing/unparseable file yields a zeroed shape with byModel [].
 *
 * Field mapping (ASSUMED from plan + public Codex docs; confirm against a real
 * rollout file): usage lives on `turn.completed` events as
 *   { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }.
 *   inputTokens        = input_tokens
 *   cacheReadTokens    = cached_input_tokens
 *   cacheCreationTokens= 0  (Codex has no separate cache-creation count — never fabricate)
 *   outputTokens       = output_tokens + reasoning_output_tokens (reasoning is billed output)
 *   messageCount       = number of turn.completed events
 */
export function parseCodexUsage(filePath: string): RawUsage {
  const rows = new Map<string | null, RawModelUsage>();
  let currentModel: string | null = null;
  let firstModel: string | null = null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return { ...emptyModelRow(null), byModel: [] };
  }

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Model id may appear on thread.started / session_meta / turn metadata.
    // ASSUMED: any of these shapes; adjust to the real model-bearing line.
    const m =
      (ev['model'] as string | undefined) ??
      ((ev['thread'] as Record<string, unknown> | undefined)?.['model'] as string | undefined) ??
      ((ev['turn'] as Record<string, unknown> | undefined)?.['model'] as string | undefined) ??
      ((ev['payload'] as Record<string, unknown> | undefined)?.['model'] as string | undefined);
    if (typeof m === 'string') {
      currentModel = m;
      if (!firstModel) firstModel = m;
    }

    const usage = ev['usage'] as Record<string, unknown> | undefined;
    if (!usage) continue;

    const row = rows.get(currentModel) ?? emptyModelRow(currentModel);
    row.inputTokens += (usage['input_tokens'] as number) ?? 0;
    row.cacheReadTokens += (usage['cached_input_tokens'] as number) ?? 0;
    // No cache_creation count in Codex — leave at 0.
    row.outputTokens +=
      ((usage['output_tokens'] as number) ?? 0) +
      ((usage['reasoning_output_tokens'] as number) ?? 0);
    row.messageCount++;
    rows.set(currentModel, row);
  }

  const byModel = [...rows.values()];
  const totals = byModel.reduce<RawModelUsage>(
    (acc, r) => ({
      model: acc.model ?? r.model,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      messageCount: acc.messageCount + r.messageCount,
    }),
    emptyModelRow(firstModel),
  );

  return { ...totals, model: firstModel, byModel };
}

/** Walk sessions/YYYY/MM/DD and return rollout JSONL paths modified within the window. */
export function listCodexRollouts(sinceMs = 0, root = CODEX_SESSIONS_DIR): string[] {
  if (!existsSync(root)) return [];
  const cutoff = sinceMs > 0 ? Date.now() - sinceMs : 0;
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const fp = join(dir, name);
      let st;
      try {
        st = statSync(fp);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(fp);
        continue;
      }
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      if (cutoff > 0 && st.mtimeMs < cutoff) continue;
      out.push(fp);
    }
  };
  walk(root);
  return out;
}

/** Find a rollout file whose name contains the session id. */
export function locateCodexRollout(sessionId: string, root = CODEX_SESSIONS_DIR): string | null {
  for (const p of listCodexRollouts(0, root)) {
    if (p.includes(sessionId)) return p;
  }
  return null;
}

/** Codex models, derived from the registry so values stay in sync with resolveModel. */
const CODEX_MODELS: ModelOption[] = MODEL_REGISTRY.filter((m) => m.provider === 'codex').map((m) => ({
  value: m.id,
  label: m.label,
}));

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly label = 'OpenAI Codex';
  // ASSUMED: exact wording; the seat-auth flow (codex login → ChatGPT OAuth, no API key) is verified.
  readonly authHint =
    'Sign in to Codex with your ChatGPT account (run `codex login`). No API key required.';
  readonly models: ModelOption[] = CODEX_MODELS;

  // Prompt is a positional launch arg (codex exec "<prompt>"), so PtyManager
  // appends it — buildStartArgs/buildResumeArgs deliberately exclude it.
  readonly promptStrategy: PromptStrategy = { kind: 'flag' };

  readonly capabilities: AgentCapabilities = {
    canObserveHooks: false, // no Claude-style hook system; cannot stream PreToolUse/Stop events
    canResume: true, // codex exec resume <id> "<prompt>"
    // ASSUMED: MCP is configurable for headless `exec` via ~/.codex/config.toml
    // [mcp_servers.*] (there is no --mcp-config flag like Claude). Spike Step 5
    // must confirm; if headless exec cannot load MCP servers, set this false and
    // a Codex goal cannot orchestrate siblings via the claude-deck MCP server.
    canMcp: true,
    canApprove: false, // headless exec has no interceptable approval round-trip
    canStream: true, // --json yields a live NDJSON event stream on stdout
  };

  resolveBinary(): string {
    if (cachedPath) return cachedPath;
    try {
      const out = execSync(process.platform === 'win32' ? 'where codex' : 'which codex', {
        encoding: 'utf-8',
      });
      cachedPath = pickCodexBinary(out, process.platform);
    } catch {
      cachedPath = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    }
    return cachedPath;
  }

  // ASSUMED: sandbox/approval value names per plan + OpenAI docs.
  // autonomous  → --sandbox workspace-write --ask-for-approval never
  // supervised  → --sandbox read-only      --ask-for-approval on-request
  private sandboxArgs(mode: SpawnContext['permissionMode']): string[] {
    return mode === 'autonomous'
      ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
      : ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'];
  }

  buildStartArgs(ctx: SpawnContext): string[] {
    const args: string[] = ['exec', '--json'];
    if (ctx.model && ctx.model !== 'default') args.push('--model', ctx.model);
    args.push('-C', ctx.cwd);
    args.push(...this.sandboxArgs(ctx.permissionMode));
    // MCP: configured via ~/.codex/config.toml [mcp_servers.*], NOT a flag. When
    // canMcp, prepareContext (or a config-merge helper) writes it before spawn;
    // no argv change here. NO API keys.
    // Prompt is appended by PtyManager (promptStrategy.kind === 'flag').
    return args;
  }

  buildResumeArgs(sessionId: string, ctx: SpawnContext): string[] {
    // ASSUMED: resume is the `exec resume <id>` subcommand (not a --resume flag).
    const args: string[] = ['exec', 'resume', sessionId, '--json'];
    args.push(...this.sandboxArgs(ctx.permissionMode));
    return args;
  }

  /** Generate AGENTS.md from the shared goal context so the same markdown drives a Codex goal. */
  prepareContext(ctx: SpawnContext): void {
    try {
      const target = join(ctx.cwd, 'AGENTS.md');
      // ASSUMED: the Phase 1 shared goal-doc builder is not present in this scope,
      // so write a minimal honest header. Replace with the shared builder once it
      // lands so Claude (CLAUDE.md) and Codex (AGENTS.md) emit identical bodies.
      const body = [
        `# Agent Context (goal ${ctx.goalId})`,
        '',
        'This file is generated by claude-deck so any agent CLI reads the same project context.',
        '',
        '<!-- shared goal docs (plan / research / notes / handoff / todo) are injected here -->',
        '',
      ].join('\n');
      writeFileSync(target, body, 'utf-8');
    } catch (err) {
      logger.warn({ err, goalId: ctx.goalId }, 'CodexAdapter: failed to write AGENTS.md');
    }
  }

  // No hook system — honest no-ops.
  async installHooks(): Promise<void> {
    /* codex has no hook system */
  }
  async uninstallHooks(): Promise<void> {
    /* codex has no hook system */
  }
  async hooksInstalled(): Promise<boolean> {
    return false;
  }

  locateSessionLog(sessionId: string): string | null {
    return locateCodexRollout(sessionId);
  }
  parseUsage(logPath: string): RawUsage {
    return parseCodexUsage(logPath);
  }
  listSessionLogs(sinceMs: number): string[] {
    return listCodexRollouts(sinceMs);
  }

  pricingFor(model: string): ModelPricing {
    const entry = resolveModel(model);
    // Codex models are seat-priced (registry pricing === null) — zero pricing,
    // i.e. "equivalent value 0" until a public reference rate is added.
    if (!entry || entry.pricing === null) {
      return { input: 0, cache_read: 0, cache_creation: 0, output: 0 };
    }
    return entry.pricing;
  }

  contextWindowFor(model: string, currentTokens: number): number {
    const entry = resolveModel(model);
    const base = entry?.contextWindow ?? 400_000;
    return currentTokens > base ? currentTokens : base;
  }
}
