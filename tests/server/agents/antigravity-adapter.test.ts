import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravityAdapter } from '../../../server/agents/antigravity-adapter';
import type { SpawnContext } from '../../../src/shared/agents/types';

const a = new AntigravityAdapter();

const base: SpawnContext = {
  goalId: 'goal-1',
  model: 'antigravity',
  cwd: '/repo',
  permissionMode: 'supervised',
  mcpServer: null,
};

// ── Inline transcript fixture (JSONL append-log) ────────────────────────────
//
// Encodes the CUMULATIVE-TOKEN DEDUP scenario:
//   - m-gem-1 is written TWICE (streaming partial + final) with identical
//     tokens  → must be DEDUPED by id (counted once).
//   - input/cached GROW across turns (11918 → 12164, 3178 → 10678) because each
//     turn's input is the full cumulative context  → take MAX (last), not sum.
//   - output is a per-turn DELTA (52, then 661)  → SUM = 713.
const TRANSCRIPT_LINES = [
  `{"sessionId":"aaaaaaaa-1111-2222-3333-444444444444","projectHash":"deadbeef","startTime":"2026-06-09T17:49:42.902Z","lastUpdated":"2026-06-09T17:50:50.000Z","kind":"main"}`,
  `{"$set":{"messages":[],"lastUpdated":"2026-06-09T17:49:42.904Z"}}`,
  `{"id":"m-user-1","timestamp":"2026-06-09T17:49:42.904Z","type":"user","content":[{"text":"hello"}]}`,
  `{"id":"m-gem-1","timestamp":"2026-06-09T17:50:00.000Z","type":"gemini","content":"hi","tokens":{"input":11918,"output":52,"cached":3178,"thoughts":96,"tool":0,"total":12066},"model":"gemini-2.5-pro"}`,
  `{"id":"m-gem-1","timestamp":"2026-06-09T17:50:00.500Z","type":"gemini","content":"hi","tokens":{"input":11918,"output":52,"cached":3178,"thoughts":96,"tool":0,"total":12066},"model":"gemini-2.5-pro"}`,
  `{"$set":{"lastUpdated":"2026-06-09T17:50:01.000Z"}}`,
  `{"id":"m-gem-2","timestamp":"2026-06-09T17:50:40.000Z","type":"gemini","content":"more","tokens":{"input":12164,"output":661,"cached":10678,"thoughts":22,"tool":0,"total":12847},"model":"gemini-2.5-pro"}`,
  `{"$set":{"lastUpdated":"2026-06-09T17:50:50.000Z"}}`,
];

let dir: string;
let fixture: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-test-'));
  fixture = join(dir, 'session-2026-06-09T17-49-aaaaaaaa.jsonl');
  writeFileSync(fixture, TRANSCRIPT_LINES.join('\n') + '\n', 'utf-8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AntigravityAdapter identity & catalog', () => {
  it('has the antigravity id/label and a seat auth hint mentioning agy', () => {
    expect(a.id).toBe('antigravity');
    expect(a.label).toBe('Antigravity');
    expect(a.authHint).toMatch(/agy/);
  });

  it('exposes registry-sourced gemini model options with matching ids', () => {
    const values = a.models.map((m) => m.value);
    expect(values).toContain('gemini-3-pro');
    expect(values).toContain('gemini-flash-2.5');
    // Every option value resolves in the registry (values MUST match ids).
    for (const m of a.models) expect(m.value).toBeTruthy();
  });

  it('declares an honest capability matrix (no hooks, no approve, no mcp)', () => {
    expect(a.capabilities).toEqual({
      canObserveHooks: false,
      canResume: true,
      canMcp: false,
      canApprove: false,
      canStream: true,
    });
  });

  it('uses the flag prompt strategy', () => {
    expect(a.promptStrategy).toEqual({ kind: 'flag' });
  });
});

describe('AntigravityAdapter launch args (real agy v1.0.7 flags)', () => {
  it('start: supervised → no autonomy flag, adds --add-dir for cwd', () => {
    expect(a.buildStartArgs(base)).toEqual(['--add-dir', '/repo']);
  });

  it('start: autonomous → --dangerously-skip-permissions', () => {
    expect(a.buildStartArgs({ ...base, permissionMode: 'autonomous' })).toEqual([
      '--add-dir',
      '/repo',
      '--dangerously-skip-permissions',
    ]);
  });

  it('start: concrete gemini model → --model <id> first', () => {
    expect(a.buildStartArgs({ ...base, model: 'gemini-3-pro' })).toEqual([
      '--model',
      'gemini-3-pro',
      '--add-dir',
      '/repo',
    ]);
  });

  it('resume: --conversation <id> first, no --model', () => {
    expect(a.buildResumeArgs('conv-9', { ...base, model: 'gemini-3-pro' })).toEqual([
      '--conversation',
      'conv-9',
      '--add-dir',
      '/repo',
    ]);
  });

  it('resume: autonomous adds the skip-permissions flag', () => {
    expect(a.buildResumeArgs('conv-9', { ...base, permissionMode: 'autonomous' })).toEqual([
      '--conversation',
      'conv-9',
      '--add-dir',
      '/repo',
      '--dangerously-skip-permissions',
    ]);
  });

  it('never includes an API key flag', () => {
    const all = [
      ...a.buildStartArgs({ ...base, permissionMode: 'autonomous', model: 'gemini-3-pro' }),
      ...a.buildResumeArgs('conv-9', base),
    ];
    expect(all.some((arg) => /api[-_]?key/i.test(arg))).toBe(false);
  });
});

describe('AntigravityAdapter.parseUsage (cumulative-token dedup)', () => {
  it('dedupes by id, sums output deltas, takes max of cumulative input/cache', () => {
    const u = a.parseUsage(fixture);
    expect(u.messageCount).toBe(2); // m-gem-1 (deduped) + m-gem-2
    expect(u.outputTokens).toBe(713); // 52 + 661 (deltas summed)
    expect(u.inputTokens).toBe(12164); // max(11918, 12164) — cumulative → last
    expect(u.cacheReadTokens).toBe(10678); // max(3178, 10678) — cumulative → last
    expect(u.cacheCreationTokens).toBe(0); // no separate count
    expect(u.model).toBe('gemini-2.5-pro');
  });

  it('populates byModel with one row mirroring the totals', () => {
    const u = a.parseUsage(fixture);
    expect(u.byModel).toHaveLength(1);
    expect(u.byModel[0]).toEqual({
      model: 'gemini-2.5-pro',
      inputTokens: 12164,
      outputTokens: 713,
      cacheReadTokens: 10678,
      cacheCreationTokens: 0,
      messageCount: 2,
    });
  });

  it('does NOT inflate input by summing cumulative turns', () => {
    // Naive sum would be 11918 + 12164 = 24082; the dedup rule yields 12164.
    const u = a.parseUsage(fixture);
    expect(u.inputTokens).toBeLessThan(11918 + 12164);
  });

  it('splits byModel when a session routes to multiple models', () => {
    const multi = join(dir, 'multi.jsonl');
    writeFileSync(
      multi,
      [
        `{"sessionId":"bbbb","startTime":"2026-06-09T00:00:00.000Z","kind":"main"}`,
        `{"id":"g1","type":"gemini","tokens":{"input":100,"output":10,"cached":0,"thoughts":0,"tool":0,"total":110},"model":"gemini-2.5-pro"}`,
        `{"id":"g2","type":"gemini","tokens":{"input":200,"output":20,"cached":0,"thoughts":0,"tool":0,"total":220},"model":"gemini-2.5-flash"}`,
      ].join('\n'),
      'utf-8',
    );
    const u = a.parseUsage(multi);
    expect(u.byModel).toHaveLength(2);
    expect(u.messageCount).toBe(2);
    expect(u.outputTokens).toBe(30); // 10 + 20 across both models
  });

  it('returns zeroed usage for a missing/unparseable file (never throws)', () => {
    const u = a.parseUsage(join(dir, 'no-such-file.jsonl'));
    expect(u.messageCount).toBe(0);
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
    expect(u.model).toBeNull();
    expect(u.byModel).toEqual([]);

    const garbage = join(dir, 'garbage.jsonl');
    writeFileSync(garbage, 'not json at all\n{also bad\n', 'utf-8');
    expect(a.parseUsage(garbage).messageCount).toBe(0);
  });
});

describe('AntigravityAdapter pricing & context window (seat)', () => {
  it('pricingFor a gemini (seat) model is zeroed / unpriced', () => {
    expect(a.pricingFor('gemini-2.5-pro')).toEqual({
      input: 0,
      cache_read: 0,
      cache_creation: 0,
      output: 0,
    });
    expect(a.pricingFor('gemini-3-pro')).toEqual({
      input: 0,
      cache_read: 0,
      cache_creation: 0,
      output: 0,
    });
  });

  it('contextWindowFor returns ~1M for gemini and a sane default otherwise', () => {
    expect(a.contextWindowFor('gemini-3-pro', 0)).toBe(1_000_000);
    expect(a.contextWindowFor('totally-unknown-model', 0)).toBe(1_000_000);
  });

  it('contextWindowFor grows when current tokens exceed the window', () => {
    expect(a.contextWindowFor('gemini-3-pro', 2_000_000)).toBe(2_000_000);
  });
});

describe('AntigravityAdapter hooks & binary', () => {
  it('hooks are honest no-ops', async () => {
    await expect(a.installHooks()).resolves.toBeUndefined();
    await expect(a.uninstallHooks()).resolves.toBeUndefined();
    expect(await a.hooksInstalled()).toBe(false);
  });

  it('resolveBinary returns a non-empty agy path', () => {
    expect(a.resolveBinary()).toMatch(/agy/);
  });
});

describe('AntigravityAdapter session log discovery', () => {
  it('lists and locates transcripts under ANTIGRAVITY_HOME', () => {
    // Lay out home/<project>/chats/<file> matching the fixture.
    const home = mkdtempSync(join(tmpdir(), 'agy-home-'));
    const chats = join(home, 'proj1', 'chats');
    mkdtempSync(join(tmpdir(), 'unused-')); // noise dir, ignored
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(chats, { recursive: true });
    const logFile = join(chats, 'session-2026-06-09T17-49-aaaaaaaa.jsonl');
    writeFileSync(logFile, TRANSCRIPT_LINES.join('\n') + '\n', 'utf-8');

    const prev = process.env['ANTIGRAVITY_HOME'];
    process.env['ANTIGRAVITY_HOME'] = home;
    try {
      const logs = a.listSessionLogs(0);
      expect(logs).toContain(logFile);
      // by header sessionId
      expect(a.locateSessionLog('aaaaaaaa-1111-2222-3333-444444444444')).toBe(logFile);
      // by shortid embedded in the filename
      expect(a.locateSessionLog('aaaaaaaa')).toBe(logFile);
      expect(a.locateSessionLog('does-not-exist')).toBeNull();
    } finally {
      if (prev === undefined) delete process.env['ANTIGRAVITY_HOME'];
      else process.env['ANTIGRAVITY_HOME'] = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns [] when ANTIGRAVITY_HOME does not exist', () => {
    const prev = process.env['ANTIGRAVITY_HOME'];
    process.env['ANTIGRAVITY_HOME'] = join(tmpdir(), 'definitely-missing-agy-home-xyz');
    try {
      expect(a.listSessionLogs(0)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env['ANTIGRAVITY_HOME'];
      else process.env['ANTIGRAVITY_HOME'] = prev;
    }
  });
});
