// server/agents/antigravity-adapter.ts
//
// AgentAdapter for Google Antigravity — the headless `agy` CLI (built on the
// Gemini agent core, Gemini models, OAuth subscription "seat", no API key).
//
// Spec: docs/superpowers/plans/2026-06-09-antigravity-adapter.md. The plan's
// top "REAL agy v1.0.7 spike (2026-06-11)" section OVERRIDES the proxy §2 where
// they conflict — launch flags below follow the real spike. The real on-disk
// store is protobuf-in-SQLite; this adapter's parseUsage is written against the
// JSONL append-log transcript shape (the documented/portable form) and APPLIES
// THE CUMULATIVE-TOKEN DEDUP so per-turn running totals are not double-counted.
//
// The real `agy` is not installed in this environment — nothing is verified at
// runtime. Items the real CLI must confirm are marked `// ASSUMED:`.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

const ZERO_PRICING: ModelPricing = { input: 0, cache_read: 0, cache_creation: 0, output: 0 };

let cachedBinary: string | null = null;

/**
 * Base dir of the agy conversation store. Resolved per-call (NOT a module-level
 * const) so tests / the re-spike can override via ANTIGRAVITY_HOME.
 * ASSUMED: default layout `~/.gemini/antigravity-cli/conversations` (real spike
 * found the SQLite `.db` store there); the JSONL transcript reader scans a
 * `chats/` subtree under each project for the documented append-log form.
 */
function antigravityHome(): string {
  return process.env['ANTIGRAVITY_HOME'] ?? join(homedir(), '.gemini', 'tmp');
}

// ── Transcript shape (Gemini/Antigravity JSONL append-log) ──────────────────

interface GeminiTokens {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool: number;
  total: number;
}

interface GeminiTurn {
  id: string;
  model: string | null;
  tokens: GeminiTokens;
}

interface AntigravityTranscript {
  sessionId: string | null;
  /** gemini turns, deduped by id (last write wins), in first-seen order. */
  geminiTurns: GeminiTurn[];
}

const EMPTY_TOKENS: GeminiTokens = {
  input: 0,
  output: 0,
  cached: 0,
  thoughts: 0,
  tool: 0,
  total: 0,
};

const EMPTY_TRANSCRIPT: AntigravityTranscript = { sessionId: null, geminiTurns: [] };

/**
 * Read a Gemini/Antigravity transcript: a `.jsonl` append-log (one JSON object
 * per line) or a legacy single-object `.json` (`{ ..., messages: [...] }`).
 * Never throws — returns an empty transcript on any read/parse failure.
 */
function readTranscript(filePath: string): AntigravityTranscript {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return EMPTY_TRANSCRIPT;
  }

  // Legacy single-object `.json`: parse whole-file, read messages[].
  const trimmed = content.trimStart();
  if (filePath.endsWith('.json') || (trimmed.startsWith('{') && !trimmed.includes('\n{'))) {
    try {
      const obj = JSON.parse(content) as { sessionId?: unknown; messages?: unknown };
      if (obj && Array.isArray(obj.messages)) {
        return collect(typeof obj.sessionId === 'string' ? obj.sessionId : null, obj.messages);
      }
    } catch {
      // fall through to line mode
    }
  }

  let sessionId: string | null = null;
  const messages: unknown[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    // Session header line: `{ sessionId, projectHash, startTime, ... }`.
    if (typeof obj['sessionId'] === 'string' && obj['startTime']) {
      sessionId = obj['sessionId'];
      continue;
    }
    // `$set` bookkeeping; may seed an initial `messages` array.
    if (obj['$set']) {
      const set = obj['$set'] as { messages?: unknown };
      if (Array.isArray(set.messages)) messages.push(...set.messages);
      continue;
    }
    if (obj['type']) messages.push(obj);
  }
  return collect(sessionId, messages);
}

/**
 * Collapse raw messages into deduped gemini turns. The streaming writer emits a
 * partial then a final line with the SAME `id` and identical `tokens` — keep the
 * last write per id (de-dup). Only `type === 'gemini'` messages with a `tokens`
 * object carry usage.
 */
function collect(sessionId: string | null, messages: unknown[]): AntigravityTranscript {
  const byId = new Map<string, GeminiTurn>();
  const order: string[] = [];
  for (const raw of messages) {
    const m = raw as {
      id?: unknown;
      type?: unknown;
      model?: unknown;
      tokens?: Partial<GeminiTokens>;
    };
    if (!m || m.type !== 'gemini' || !m.tokens) continue;
    const id = typeof m.id === 'string' ? m.id : `${order.length}`;
    if (!byId.has(id)) order.push(id);
    byId.set(id, {
      id,
      model: typeof m.model === 'string' ? m.model : null,
      tokens: { ...EMPTY_TOKENS, ...m.tokens },
    });
  }
  return { sessionId, geminiTurns: order.map((id) => byId.get(id)!) };
}

function emptyRawUsage(): RawUsage {
  return {
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messageCount: 0,
    byModel: [],
  };
}

/**
 * Aggregate deduped gemini turns into RawUsage, applying the CUMULATIVE-TOKEN
 * DEDUP rule:
 *   - `output` (and `thoughts`) are PER-TURN DELTAS  → SUM across distinct turns.
 *   - `input` and `cached` are CUMULATIVE running totals (each turn already
 *     includes the full prior context) → TAKE THE MAX (== last turn's value),
 *     NOT the sum, so the session figure is not inflated.
 *   - `messageCount` = number of distinct gemini turns.
 * Grouped per model so multi-model sessions produce one `byModel` row each.
 */
function aggregate(turns: GeminiTurn[]): RawUsage {
  const out = emptyRawUsage();
  if (turns.length === 0) return out;

  const groups = new Map<string | null, GeminiTurn[]>();
  for (const t of turns) {
    const list = groups.get(t.model);
    if (list) list.push(t);
    else groups.set(t.model, [t]);
  }

  for (const [model, group] of groups) {
    let outputSum = 0;
    let maxInput = 0;
    let maxCached = 0;
    for (const t of group) {
      outputSum += t.tokens.output; // delta → sum
      maxInput = Math.max(maxInput, t.tokens.input); // cumulative → max (last)
      maxCached = Math.max(maxCached, t.tokens.cached); // cumulative → max (last)
    }
    const row: RawModelUsage = {
      model,
      inputTokens: maxInput,
      outputTokens: outputSum,
      cacheReadTokens: maxCached,
      cacheCreationTokens: 0, // gemini transcript has no separate cache-creation count
      messageCount: group.length,
    };
    out.byModel.push(row);
    out.inputTokens += row.inputTokens;
    out.outputTokens += row.outputTokens;
    out.cacheReadTokens += row.cacheReadTokens;
    out.messageCount += row.messageCount;
  }

  // session-level model = the dominant (most turns) model.
  out.model = out.byModel.reduce((a, b) => (b.messageCount > a.messageCount ? b : a)).model;
  return out;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  readonly label = 'Antigravity';

  // Gemini model options, sourced from the shared registry (values MUST match
  // registry ids so resolveModel()/pricingFor()/contextWindowFor() agree).
  readonly models: ModelOption[] = MODEL_REGISTRY.filter((m) => m.provider === 'antigravity').map(
    (m) => ({ value: m.id, label: m.label }),
  );

  // HONEST capability matrix (plan §2.8 + real-spike). agy has NO Claude-style
  // observable hook system and NO approval interception → false. It DOES resume
  // (`--conversation`/`-c`), streams via PTY. MCP staging is unverified for
  // headless agy → false (do not ship a half-working MCP config).
  readonly capabilities: AgentCapabilities = {
    canObserveHooks: false,
    canResume: true,
    canMcp: false,
    canApprove: false,
    canStream: true,
  };

  readonly authHint = 'Run `agy` once to sign in (Google/Antigravity seat)';

  // agy accepts the prompt as a launch flag (`-i`/`--prompt-interactive`), so the
  // PTY does not need idle/regex settle injection. ASSUMED: PtyManager supplies
  // the initial prompt for the 'flag' strategy (SpawnContext does not carry it yet).
  readonly promptStrategy: PromptStrategy = { kind: 'flag' };

  resolveBinary(): string {
    if (cachedBinary) return cachedBinary;
    try {
      let p = execSync('which agy', { encoding: 'utf-8' }).trim();
      if (p.startsWith('/c/')) p = 'C:/' + p.slice(3);
      if (process.platform === 'win32' && !p.endsWith('.exe')) p += '.exe';
      cachedBinary = p;
    } catch {
      // ASSUMED: real spike found agy at %LOCALAPPDATA%\agy\bin\agy.exe (not on
      // PATH). Prefer that on win32 if it exists; else fall back to the bare name.
      if (process.platform === 'win32') {
        const local = process.env['LOCALAPPDATA'];
        const localAgy = local ? join(local, 'agy', 'bin', 'agy.exe') : null;
        cachedBinary = localAgy && existsSync(localAgy) ? localAgy : 'agy.exe';
      } else {
        cachedBinary = 'agy';
      }
    }
    return cachedBinary;
  }

  /** Map the goal's permission mode to agy's autonomy flag (real-spike flags). */
  private approvalArgs(ctx: SpawnContext): string[] {
    // autonomous → fully autonomous; supervised → no flag (in-terminal approval).
    return ctx.permissionMode === 'autonomous' ? ['--dangerously-skip-permissions'] : [];
  }

  buildStartArgs(ctx: SpawnContext): string[] {
    // Real-spike flags: `--model <id>`, `--add-dir <cwd>`, autonomy flag.
    // NO API key. MCP is NOT inlined (canMcp=false; staging deferred).
    const args: string[] = [];
    if (ctx.model && ctx.model !== 'antigravity') args.push('--model', ctx.model);
    if (ctx.cwd) args.push('--add-dir', ctx.cwd);
    args.push(...this.approvalArgs(ctx));
    // ASSUMED: the initial prompt is appended by PtyManager as
    // `--prompt-interactive <text>` (promptStrategy 'flag'); SpawnContext does
    // not yet carry the prompt, so it is not added here.
    return args;
  }

  buildResumeArgs(sessionId: string, ctx: SpawnContext): string[] {
    // Resume by conversation id (`--conversation <ID>`). No --model on resume
    // (mirrors ClaudeAdapter — the locked session keeps its model).
    const args: string[] = ['--conversation', sessionId];
    if (ctx.cwd) args.push('--add-dir', ctx.cwd);
    args.push(...this.approvalArgs(ctx));
    return args;
  }

  prepareContext(ctx: SpawnContext): void {
    // ASSUMED: Antigravity/Gemini reads `GEMINI.md` from the cwd as its native
    // context file (analogous to CLAUDE.md). Materializing it from the shared
    // goal docs is deferred to the integration layer (the foundation's goal-doc
    // locator). Best-effort no-op here so spawning never blocks on doc-sourcing.
    void ctx;
  }

  async installHooks(): Promise<void> {
    // agy has no Claude-style observable hook system (canObserveHooks=false).
    logger.warn('AntigravityAdapter: hooks unsupported (canObserveHooks=false) — no-op');
  }

  async uninstallHooks(): Promise<void> {
    // no-op (no hooks were installed)
  }

  async hooksInstalled(): Promise<boolean> {
    return false;
  }

  locateSessionLog(sessionId: string): string | null {
    for (const fp of this.listSessionLogs(0)) {
      // shortid embedded in the filename, or full id in the transcript header.
      if (fp.includes(sessionId)) return fp;
      if (readTranscript(fp).sessionId === sessionId) return fp;
    }
    return null;
  }

  parseUsage(logPath: string): RawUsage {
    // Never throws: readTranscript/aggregate both degrade to zeroed usage.
    return aggregate(readTranscript(logPath).geminiTurns);
  }

  listSessionLogs(sinceMs: number): string[] {
    const home = antigravityHome();
    if (!existsSync(home)) return [];
    const cutoff = sinceMs > 0 ? Date.now() - sinceMs : 0;
    const paths: string[] = [];

    let projects: string[];
    try {
      projects = readdirSync(home);
    } catch {
      return [];
    }
    for (const proj of projects) {
      const chats = join(home, proj, 'chats');
      let entries: string[];
      try {
        entries = readdirSync(chats);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.endsWith('.jsonl') && !e.endsWith('.json')) continue;
        const fp = join(chats, e);
        if (cutoff > 0) {
          try {
            if (statSync(fp).mtimeMs < cutoff) continue;
          } catch {
            continue;
          }
        }
        paths.push(fp);
      }
    }
    return paths;
  }

  pricingFor(_model: string): ModelPricing {
    // Gemini models are seat (registry pricing === null) → zeroed pricing
    // (cost 0, "unpriced/equivalent-value" downstream). resolveModel()?.pricing
    // is null for every antigravity entry, so this always returns ZERO_PRICING;
    // the resolveModel call documents the single-source-of-truth dependency.
    return resolveModel(_model)?.pricing ?? ZERO_PRICING;
  }

  contextWindowFor(model: string, currentTokens: number): number {
    const w = resolveModel(model)?.contextWindow ?? 1_000_000; // gemini default ~1M
    return currentTokens > w ? w * 2 : w;
  }
}
