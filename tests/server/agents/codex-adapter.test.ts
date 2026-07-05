import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexAdapter,
  parseCodexUsage,
  listCodexRollouts,
  locateCodexRollout,
  pickCodexBinary,
  codexTrustPathKey,
  ensureCodexProjectTrusted,
  codexMcpConfigArgs,
} from '../../../server/agents/codex-adapter';
import type { SpawnContext } from '../../../src/shared/agents/types';

const base: SpawnContext = {
  goalId: 'g1',
  model: 'gpt-5.5',
  cwd: '/repo',
  permissionMode: 'supervised',
  mcpServer: null,
};
const a = new CodexAdapter();

describe('CodexAdapter — identity & catalog', () => {
  it('has codex id/label and a ChatGPT seat authHint (no api key)', () => {
    expect(a.id).toBe('codex');
    expect(a.label).toBe('OpenAI Codex');
    expect(a.authHint).toMatch(/ChatGPT/i);
    expect(a.authHint).toMatch(/No API key/i);
  });

  it('exposes the registry codex models (gpt-5.5 default + variants)', () => {
    const values = a.models.map((m) => m.value);
    expect(values).toContain('gpt-5.5');
    expect(values).toContain('gpt-5.4');
    expect(values).toContain('gpt-5.4-mini');
    expect(values).toContain('gpt-5.3-codex');
    // every value must resolve via the registry so resolveModel works
    expect(values.length).toBeGreaterThanOrEqual(4);
  });
});

describe('pickCodexBinary', () => {
  it('on Windows selects the .cmd shim, never appends .exe (no codex.exe exists)', () => {
    // npm install layout: bare git-bash script + .cmd, in `where` order.
    const out = 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd';
    expect(pickCodexBinary(out, 'win32')).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd');
  });

  it('prefers a real .exe when present', () => {
    const out = 'C:\\tools\\codex.exe\r\nC:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd';
    expect(pickCodexBinary(out, 'win32')).toBe('C:\\tools\\codex.exe');
  });

  it('appends .cmd to a lone extensionless Windows path', () => {
    expect(pickCodexBinary('C:\\Users\\me\\AppData\\Roaming\\npm\\codex', 'win32')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
    );
  });

  it('on non-Windows returns the first path as-is', () => {
    expect(pickCodexBinary('/usr/local/bin/codex\n/opt/codex', 'linux')).toBe('/usr/local/bin/codex');
  });

  it('normalizes a git-bash /c/ path', () => {
    expect(pickCodexBinary('/c/tools/codex.exe', 'win32')).toBe('C:/tools/codex.exe');
  });

  it('falls back to codex.cmd on Windows when output is empty', () => {
    expect(pickCodexBinary('', 'win32')).toBe('codex.cmd');
  });
});

describe('CodexAdapter — promptStrategy & capabilities', () => {
  it('promptStrategy is idle (prompt typed into the interactive TUI after it settles)', () => {
    expect(a.promptStrategy).toEqual({ kind: 'idle', idleMs: 3000 });
  });

  it('capabilities: honest — no hooks/approve, yes resume/mcp/stream', () => {
    expect(a.capabilities).toEqual({
      canObserveHooks: false,
      canResume: true,
      canMcp: true,
      canApprove: false,
      canStream: true,
    });
  });
});

describe('CodexAdapter — buildStartArgs (interactive, persistent session)', () => {
  it('supervised: interactive (no exec/json) + model + cwd + read-only sandbox + on-request approval', () => {
    const args = a.buildStartArgs({ ...base });
    // Interactive mode: NO `exec` subcommand and NO `--json` (those make it one-shot).
    expect(args).not.toContain('exec');
    expect(args).not.toContain('--json');
    expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-5.5']));
    expect(args).toEqual(expect.arrayContaining(['-C', '/repo']));
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
    expect(args).toEqual(expect.arrayContaining(['--ask-for-approval', 'on-request']));
    // prompt is NOT in argv (typed into the TUI after readiness)
    expect(args).not.toContain('say hello');
  });

  it('autonomous: workspace-write sandbox + never approval', () => {
    const args = a.buildStartArgs({ ...base, permissionMode: 'autonomous' });
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(args).toEqual(expect.arrayContaining(['--ask-for-approval', 'never']));
  });

  it('default model: no --model flag emitted', () => {
    const args = a.buildStartArgs({ ...base, model: 'default' });
    expect(args).not.toContain('--model');
  });

  it('never includes an api-key flag or env reference', () => {
    const joined = a.buildStartArgs({ ...base }).join(' ');
    expect(joined).not.toMatch(/api[_-]?key/i);
  });
});

describe('CodexAdapter — buildResumeArgs', () => {
  it('starts a fresh interactive session in the cwd (codex session id is not settable)', () => {
    const args = a.buildResumeArgs('sess-9', base);
    expect(args).not.toContain('exec');
    expect(args).not.toContain('resume');
    expect(args).not.toContain('sess-9');
    expect(args).toEqual(expect.arrayContaining(['-C', '/repo']));
    expect(args).toEqual(a.buildStartArgs(base));
  });
});

const mcpDescriptor = {
  name: 'claude-deck',
  command: 'node',
  args: ['C:/x/mcp/dist/index.js'],
  env: { CLAUDE_DECK_URL: 'http://127.0.0.1:4100', CLAUDE_DECK_GOAL_ID: 'g1' },
};

describe('codexMcpConfigArgs', () => {
  it('serializes the descriptor into -c mcp_servers overrides with a TOML-safe name', () => {
    const joined = codexMcpConfigArgs(mcpDescriptor).join(' ');
    expect(joined).toContain('-c mcp_servers.claude_deck.command="node"');
    expect(joined).toContain('-c mcp_servers.claude_deck.args=["C:/x/mcp/dist/index.js"]');
    expect(joined).toContain('-c mcp_servers.claude_deck.env.CLAUDE_DECK_URL="http://127.0.0.1:4100"');
    expect(joined).toContain('-c mcp_servers.claude_deck.env.CLAUDE_DECK_GOAL_ID="g1"');
  });
});

describe('CodexAdapter — buildStartArgs MCP wiring', () => {
  it('appends the MCP -c overrides when ctx.mcpServer is present (per-goal env)', () => {
    const joined = a.buildStartArgs({ ...base, mcpServer: mcpDescriptor }).join(' ');
    expect(joined).toContain('mcp_servers.claude_deck.command="node"');
    expect(joined).toContain('mcp_servers.claude_deck.env.CLAUDE_DECK_GOAL_ID="g1"');
  });
  it('omits MCP overrides when ctx.mcpServer is null', () => {
    expect(a.buildStartArgs({ ...base }).join(' ')).not.toContain('mcp_servers');
  });
});

describe('codexTrustPathKey', () => {
  it('lowercases the drive letter and uses backslashes on Windows', () => {
    expect(codexTrustPathKey('C:/github/claude-deck', 'win32')).toBe('c:\\github\\claude-deck');
  });
  it('returns the path verbatim on non-Windows', () => {
    expect(codexTrustPathKey('/home/u/repo', 'linux')).toBe('/home/u/repo');
  });
});

describe('ensureCodexProjectTrusted', () => {
  it('appends a trusted project section when absent', () => {
    const out = ensureCodexProjectTrusted('model = "gpt-5.5"\n', 'c:\\github\\claude-deck');
    expect(out).toContain("[projects.'c:\\github\\claude-deck']");
    expect(out).toContain('trust_level = "trusted"');
    expect(out!.startsWith('model = "gpt-5.5"')).toBe(true);
  });
  it('is idempotent — returns null when the project is already present', () => {
    const existing = "model = \"x\"\n\n[projects.'c:\\github\\claude-deck']\ntrust_level = \"trusted\"\n";
    expect(ensureCodexProjectTrusted(existing, 'c:\\github\\claude-deck')).toBeNull();
  });
});

describe('CodexAdapter — hooks are honest no-ops', () => {
  it('install/uninstall resolve to undefined; hooksInstalled is false', async () => {
    await expect(a.installHooks()).resolves.toBeUndefined();
    await expect(a.uninstallHooks()).resolves.toBeUndefined();
    await expect(a.hooksInstalled()).resolves.toBe(false);
  });
});

describe('CodexAdapter — pricing & context window (seat)', () => {
  it('codex models are seat-priced → zero pricing', () => {
    expect(a.pricingFor('gpt-5.5')).toEqual({
      input: 0,
      cache_read: 0,
      cache_creation: 0,
      output: 0,
    });
  });

  it('unknown model → still zero pricing (never throws / opus-defaults)', () => {
    expect(a.pricingFor('gpt-9-imaginary')).toEqual({
      input: 0,
      cache_read: 0,
      cache_creation: 0,
      output: 0,
    });
  });

  it('contextWindow comes from the registry for a known model', () => {
    // gpt-5.5 registered with contextWindow 400_000
    expect(a.contextWindowFor('gpt-5.5', 0)).toBe(400_000);
  });

  it('contextWindow never reports below currentTokens', () => {
    expect(a.contextWindowFor('gpt-5.5', 500_000)).toBe(500_000);
  });

  it('contextWindow falls back to a sane default for unknown model', () => {
    expect(a.contextWindowFor('gpt-9-imaginary', 0)).toBe(400_000);
  });
});

// ── parseUsage against an inline rollout-JSONL fixture matching the plan's
//    documented shape (turn.completed.usage with input/cached/output/reasoning) ──
const ROLLOUT_FIXTURE = [
  '{"type":"thread.started","thread_id":"th_abc","model":"gpt-5.5"}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}',
  '', // blank line — must be skipped
  'not json — must be skipped',
  '{"type":"turn.completed","usage":{"input_tokens":300,"cached_input_tokens":10,"output_tokens":80,"reasoning_output_tokens":20}}',
].join('\n');

describe('CodexAdapter — parseUsage / parseCodexUsage', () => {
  let dir: string;
  let fixture: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-usage-'));
    fixture = join(dir, 'rollout-sample.jsonl');
    writeFileSync(fixture, ROLLOUT_FIXTURE, 'utf-8');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sums turn.completed usage and rolls up session totals', () => {
    const u = a.parseUsage(fixture);
    expect(u.inputTokens).toBe(25063); // 24763 + 300
    expect(u.cacheReadTokens).toBe(24458); // 24448 + 10 (cached_input_tokens)
    expect(u.cacheCreationTokens).toBe(0); // codex has no cache-creation count
    expect(u.outputTokens).toBe(222); // (122+0) + (80+20 reasoning folded in)
    expect(u.messageCount).toBe(2); // two turn.completed events
    expect(u.model).toBe('gpt-5.5');
  });

  it('populates byModel with per-model rows that sum to the totals', () => {
    const u = a.parseUsage(fixture);
    expect(u.byModel.length).toBeGreaterThanOrEqual(1);
    expect(u.byModel[0].model).toBe('gpt-5.5');
    expect(u.byModel.reduce((s, m) => s + m.outputTokens, 0)).toBe(u.outputTokens);
    expect(u.byModel.reduce((s, m) => s + m.inputTokens, 0)).toBe(u.inputTokens);
  });

  it('groups a mid-session model switch into separate byModel rows', () => {
    const switched = [
      '{"type":"thread.started","model":"gpt-5.5"}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0}}',
      '{"type":"turn.metadata","model":"gpt-5.4-mini"}',
      '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
    ].join('\n');
    const p = join(dir, 'rollout-switch.jsonl');
    writeFileSync(p, switched, 'utf-8');
    const u = parseCodexUsage(p);
    expect(u.byModel.map((r) => r.model)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
    expect(u.outputTokens).toBe(15);
    expect(u.messageCount).toBe(2);
  });

  it('returns a zeroed shape (never throws) for a missing file', () => {
    const u = a.parseUsage(join(dir, 'no-such-file.jsonl'));
    expect(u.messageCount).toBe(0);
    expect(u.inputTokens).toBe(0);
    expect(u.byModel).toEqual([]);
  });
});

describe('CodexAdapter — listSessionLogs / locateSessionLog', () => {
  let root: string;

  beforeEach(() => {
    // sessions/YYYY/MM/DD/rollout-*.jsonl
    root = mkdtempSync(join(tmpdir(), 'codex-sessions-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks YYYY/MM/DD and returns rollout files, ignoring non-rollouts', () => {
    const sessionsRoot = join(root, 'sessions');
    const dayDir = join(sessionsRoot, '2026', '06', '09');
    mkdirSync(dayDir, { recursive: true });
    const file = join(dayDir, 'rollout-2026-06-09T12-00-00-sess-7.jsonl');
    writeFileSync(file, ROLLOUT_FIXTURE, 'utf-8');
    writeFileSync(join(dayDir, 'not-a-rollout.txt'), 'ignore me', 'utf-8');

    // Exercise the exported primitive with the injected root (listSessionLogs uses
    // the module-level ~/.codex default computed at import time).
    const paths = listCodexRollouts(0, sessionsRoot);
    expect(paths.some((p) => p.endsWith('rollout-2026-06-09T12-00-00-sess-7.jsonl'))).toBe(true);
    expect(paths.some((p) => p.endsWith('not-a-rollout.txt'))).toBe(false);
    expect(locateCodexRollout('sess-7', sessionsRoot)).toBe(file);
  });

  it('listCodexRollouts returns [] when the store does not exist', () => {
    // Injected nonexistent root — never touches the real ~/.codex, which may be
    // large or slow enough on a dev box to blow the test timeout.
    const missing = join(root, 'no-such-sessions-dir');
    expect(listCodexRollouts(60_000, missing)).toEqual([]);
  });
});

describe('CodexAdapter — prepareContext writes AGENTS.md', () => {
  let cwd: string;
  let codexHome: string;
  let priorCodexHome: string | undefined;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'codex-ctx-'));
    // Isolate CODEX_HOME so the pre-trust step can never touch the real ~/.codex/config.toml.
    codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    priorCodexHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = codexHome;
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    if (priorCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = priorCodexHome;
  });

  it('writes a non-empty AGENTS.md into ctx.cwd', () => {
    a.prepareContext({ ...base, cwd });
    const target = join(cwd, 'AGENTS.md');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8').length).toBeGreaterThan(0);
  });

  it('does not pre-trust a non-git cwd (no config.toml written)', () => {
    a.prepareContext({ ...base, cwd });
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(false);
  });
});

describe('CodexAdapter — resolveBinary', () => {
  it('returns a non-empty string (falls back if codex not on PATH)', () => {
    const bin = a.resolveBinary();
    expect(typeof bin).toBe('string');
    expect(bin.length).toBeGreaterThan(0);
    expect(bin).toMatch(/codex/);
  });
});
