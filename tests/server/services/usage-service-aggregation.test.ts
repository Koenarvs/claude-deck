import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// usage-service resolves CLAUDE_PROJECTS_DIR at module load from homedir().
// Redirect homedir to a synthetic temp "home" so the aggregation functions read
// only our fixtures — never the real ~/.claude.
const FAKE_HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'usage-agg-home-'));
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => FAKE_HOME };
});

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getAllSessionUsageSummaries,
  getAggregateTotals,
  getDailyCosts,
  parseClaudeUsage,
  claudePricingFor,
  claudeContextWindow,
  locateClaudeJsonl,
  listClaudeJsonl,
} from '../../../server/services/usage-service';

const PROJECTS_DIR = path.join(FAKE_HOME, '.claude', 'projects');

function usageLine(opts: {
  model?: string;
  input?: number;
  cacheCreate?: number;
  cacheRead?: number;
  output?: number;
  timestamp?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp,
    message: {
      model: opts.model,
      usage: {
        input_tokens: opts.input ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output ?? 0,
      },
    },
  });
}

function initLine(model: string, timestamp?: string): string {
  return JSON.stringify({ type: 'system', subtype: 'init', model, timestamp });
}

function writeSession(project: string, sessionId: string, lines: string[]): string {
  const dir = path.join(PROJECTS_DIR, project);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(fp, lines.join('\n') + '\n');
  return fp;
}

function resetProjectsDir(): void {
  fs.rmSync(PROJECTS_DIR, { recursive: true, force: true });
}

afterAll(() => {
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

describe('usage-service aggregation (synthetic ~/.claude/projects)', () => {
  beforeEach(() => {
    resetProjectsDir();
  });

  describe('empty / missing projects dir', () => {
    it('returns zero totals when the projects dir does not exist', () => {
      expect(getAggregateTotals()).toEqual({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
      expect(getDailyCosts()).toEqual([]);
      expect(getAllSessionUsageSummaries()).toEqual([]);
      expect(listClaudeJsonl()).toEqual([]);
      expect(locateClaudeJsonl('anything')).toBeNull();
    });

    it('ignores non-jsonl files and sessions with no usage messages', () => {
      fs.mkdirSync(path.join(PROJECTS_DIR, 'proj-a'), { recursive: true });
      fs.writeFileSync(path.join(PROJECTS_DIR, 'proj-a', 'notes.txt'), 'not a transcript');
      writeSession('proj-a', 'sess-empty', [initLine('claude-sonnet-4')]);

      expect(getAllSessionUsageSummaries()).toEqual([]);
      expect(getAggregateTotals()).toEqual({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
    });
  });

  describe('getAllSessionUsageSummaries', () => {
    it('sums tokens, detects the model, and prices with registry rates', () => {
      // Sonnet: $3/M input, $0.30/M cache_read, $3.75/M cache_creation, $15/M output
      writeSession('proj-a', 'sess-1', [
        initLine('claude-sonnet-4', '2026-01-02T10:00:00.000Z'),
        usageLine({ input: 1000, output: 1000, timestamp: '2026-01-02T10:00:01.000Z' }),
        usageLine({ input: 0, cacheRead: 10000, cacheCreate: 2000, output: 0 }),
        'this line is not json {{{',
      ]);

      const summaries = getAllSessionUsageSummaries();
      expect(summaries).toHaveLength(1);
      const s = summaries[0]!;
      expect(s.sessionId).toBe('sess-1');
      expect(s.model).toBe('claude-sonnet-4');
      expect(s.inputTokens).toBe(1000);
      expect(s.cacheReadTokens).toBe(10000);
      expect(s.cacheCreationTokens).toBe(2000);
      expect(s.outputTokens).toBe(1000);
      expect(s.totalTokens).toBe(14000);
      expect(s.messageCount).toBe(2);
      // 1000*3e-6 + 10000*0.3e-6 + 2000*3.75e-6 + 1000*15e-6
      // = 0.003 + 0.003 + 0.0075 + 0.015 = 0.0285
      expect(s.estimatedCostUsd).toBeCloseTo(0.0285, 6);
      // firstMessageAt comes from the first JSONL timestamp
      expect(s.firstMessageAt).toBe(new Date('2026-01-02T10:00:00.000Z').getTime());
    });

    it('prices unknown models as 0 (no Opus fallback)', () => {
      writeSession('proj-a', 'sess-unknown', [
        initLine('mystery-model-9000'),
        usageLine({ input: 1_000_000, output: 1_000_000 }),
      ]);

      const summaries = getAllSessionUsageSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.model).toBe('mystery-model-9000');
      expect(summaries[0]!.estimatedCostUsd).toBe(0);
    });

    it('characterization: model nested in message.model is NOT detected (session goes unpriced)', () => {
      // getAllSessionUsageSummaries only reads init events or a top-level `model`
      // field; parseClaudeUsage (the adapter primitive) DOES read message.model.
      // Real Claude transcripts carry the model on message.model, so sessions
      // without an init line are silently uncosted here.
      writeSession('proj-a', 'sess-nested-model', [
        usageLine({ model: 'claude-opus-4', input: 1_000_000, output: 0 }),
      ]);

      const summaries = getAllSessionUsageSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.model).toBeNull();
      expect(summaries[0]!.estimatedCostUsd).toBe(0);
    });

    it('falls back to file mtime when no timestamp exists in the JSONL', () => {
      const fp = writeSession('proj-a', 'sess-no-ts', [usageLine({ input: 10, output: 10 })]);
      const mtime = fs.statSync(fp).mtimeMs;

      const summaries = getAllSessionUsageSummaries();
      expect(summaries[0]!.firstMessageAt).toBe(mtime);
      expect(summaries[0]!.fileModifiedAt).toBe(mtime);
    });

    it('excludes files older than the sinceDaysAgo cutoff (by mtime)', () => {
      const oldFp = writeSession('proj-a', 'sess-old', [usageLine({ input: 1, output: 1 })]);
      writeSession('proj-a', 'sess-new', [usageLine({ input: 2, output: 2 })]);

      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldFp, tenDaysAgo, tenDaysAgo);

      const recent = getAllSessionUsageSummaries(5);
      expect(recent.map((s) => s.sessionId)).toEqual(['sess-new']);

      const all = getAllSessionUsageSummaries(0);
      expect(all.map((s) => s.sessionId).sort()).toEqual(['sess-new', 'sess-old']);
    });
  });

  describe('getAggregateTotals', () => {
    it('aggregates cost and tokens across sessions in multiple projects', () => {
      // Haiku: $0.8/M in, $4/M out
      writeSession('proj-a', 'sess-1', [
        initLine('claude-haiku-3'),
        usageLine({ input: 1_000_000, output: 0 }), // $0.80
      ]);
      writeSession('proj-b', 'sess-2', [
        initLine('claude-haiku-3'),
        usageLine({ input: 0, cacheRead: 500, cacheCreate: 300, output: 1_000_000 }), // ~$4.00
      ]);

      const totals = getAggregateTotals();
      expect(totals.sessions).toBe(2);
      // tokensIn = input + cache_creation + cache_read
      expect(totals.tokensIn).toBe(1_000_000 + 500 + 300);
      expect(totals.tokensOut).toBe(1_000_000);
      // 0.8 + (500*0.08e-6 + 300*1e-6 + 4) = 4.80004 + 0.0003 -> rounded to 4 dp
      expect(totals.cost).toBeCloseTo(0.8 + 0.00004 + 0.0003 + 4, 4);
    });
  });

  describe('getDailyCosts', () => {
    it('groups sessions by first-message date and sorts ascending', () => {
      // Opus: $15/M in, $75/M out. Model must come from an init line (or a
      // top-level `model` field) — summaries do not read message.model.
      writeSession('proj-a', 'sess-day2', [
        initLine('claude-opus-4', '2026-01-02T12:00:00.000Z'),
        usageLine({ input: 1_000_000, output: 0 }),
      ]);
      writeSession('proj-a', 'sess-day1-a', [
        initLine('claude-opus-4', '2026-01-01T08:00:00.000Z'),
        usageLine({ input: 0, output: 1_000_000 }),
      ]);
      writeSession('proj-b', 'sess-day1-b', [
        initLine('claude-opus-4', '2026-01-01T23:59:59.000Z'),
        usageLine({ input: 1_000_000, output: 0 }),
      ]);

      const daily = getDailyCosts(0);
      expect(daily).toEqual([
        { date: '2026-01-01', cost: 90, sessions: 2 }, // $75 out + $15 in
        { date: '2026-01-02', cost: 15, sessions: 1 },
      ]);
    });
  });

  describe('locateClaudeJsonl / listClaudeJsonl', () => {
    it('locates a transcript by session id across project dirs', () => {
      const fp = writeSession('proj-b', 'sess-find-me', [usageLine({ input: 1 })]);
      expect(locateClaudeJsonl('sess-find-me')).toBe(fp);
      expect(locateClaudeJsonl('sess-missing')).toBeNull();
    });

    it('lists transcript paths and honors the sinceMs cutoff', () => {
      const oldFp = writeSession('proj-a', 'sess-old', [usageLine({ input: 1 })]);
      const newFp = writeSession('proj-a', 'sess-new', [usageLine({ input: 1 })]);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(oldFp, twoHoursAgo, twoHoursAgo);

      expect(listClaudeJsonl().sort()).toEqual([oldFp, newFp].sort());
      expect(listClaudeJsonl(60 * 60 * 1000)).toEqual([newFp]);
    });
  });

  describe('parseClaudeUsage (per-model breakdown)', () => {
    it('splits byModel per per-message model and keeps the init model at the top level', () => {
      const fp = writeSession('proj-a', 'sess-multi', [
        initLine('claude-opus-4'),
        usageLine({ model: 'claude-opus-4', input: 100, output: 10 }),
        usageLine({ model: 'claude-haiku-3', input: 200, output: 20 }),
        usageLine({ input: 300, output: 30 }), // no per-message model -> init model
      ]);

      const raw = parseClaudeUsage(fp);
      expect(raw.model).toBe('claude-opus-4');
      expect(raw.inputTokens).toBe(600);
      expect(raw.outputTokens).toBe(60);
      expect(raw.messageCount).toBe(3);

      const byModel = new Map(raw.byModel.map((r) => [r.model, r]));
      expect(byModel.size).toBe(2);
      expect(byModel.get('claude-opus-4')).toMatchObject({
        inputTokens: 400,
        outputTokens: 40,
        messageCount: 2,
      });
      expect(byModel.get('claude-haiku-3')).toMatchObject({
        inputTokens: 200,
        outputTokens: 20,
        messageCount: 1,
      });
    });

    it('returns the empty shape for a missing file', () => {
      expect(parseClaudeUsage(path.join(PROJECTS_DIR, 'nope', 'missing.jsonl'))).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        messageCount: 0,
        model: null,
        byModel: [],
      });
    });
  });

  describe('pricing / context-window helpers', () => {
    it('claudePricingFor returns zeros for unknown models instead of null', () => {
      expect(claudePricingFor('mystery-model')).toEqual({
        input: 0,
        cache_read: 0,
        cache_creation: 0,
        output: 0,
      });
      expect(claudePricingFor(null)).toEqual({
        input: 0,
        cache_read: 0,
        cache_creation: 0,
        output: 0,
      });
    });

    it('claudeContextWindow: registry window, [1m] tag, and observed-token override', () => {
      expect(claudeContextWindow('claude-opus-4', 0)).toBe(200_000);
      expect(claudeContextWindow('claude-opus-4[1m]', 0)).toBe(1_000_000);
      // Observed tokens beyond 200K force the 1M window even for unknown models
      expect(claudeContextWindow('mystery-model', 250_000)).toBe(1_000_000);
      // Unknown model defaults to the legacy 200K
      expect(claudeContextWindow('mystery-model', 100)).toBe(200_000);
    });
  });
});
