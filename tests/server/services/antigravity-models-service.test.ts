// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  parseAgyModels,
  createAntigravityModelsService,
  type PtyProc,
} from '../../../server/services/antigravity-models-service';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// A faithful sample of `agy models` TTY output: braille spinner frames + an OSC window
// title + the "Fetching available models..." text, glued (via \r) to the model lines.
const SPINNER = '⠋';
const RAW_OUTPUT =
  `${SPINNER} Fetching available models...\r` +
  `\x1B]0;C:\\Users\\Koena\\AppData\\Local\\agy\\bin\\agy.exe\x07` +
  `⠙ Fetching available models...\r` +
  `⠹ Fetching available models...\r` +
  `Gemini 3.5 Flash (Medium)\r\n` +
  `Gemini 3.5 Flash (High)\r\n` +
  `Gemini 3.5 Flash (Low)\r\n` +
  `Gemini 3.1 Pro (Low)\r\n` +
  `Gemini 3.1 Pro (High)\r\n` +
  `Claude Sonnet 4.6 (Thinking)\r\n` +
  `Claude Opus 4.6 (Thinking)\r\n` +
  `GPT-OSS 120B (Medium)\r\n`;

const EXPECTED = [
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (Low)',
  'Gemini 3.1 Pro (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
];

/** A fake PtyProc that emits the given chunks then exits on the next tick. */
function fakePty(chunks: string[]): PtyProc {
  let onData: (d: string) => void = () => {};
  let onExit: () => void = () => {};
  queueMicrotask(() => {
    for (const c of chunks) onData(c);
    onExit();
  });
  return {
    onData: (cb) => { onData = cb; },
    onExit: (cb) => { onExit = cb; },
    kill: () => {},
  };
}

describe('parseAgyModels', () => {
  it('extracts the model names, stripping spinner/ANSI/OSC/progress noise', () => {
    expect(parseAgyModels(RAW_OUTPUT).map((m) => m.value)).toEqual(EXPECTED);
  });

  it('uses the display name for both value and label (selection is by name)', () => {
    const opts = parseAgyModels(RAW_OUTPUT);
    expect(opts[0]).toEqual({ value: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' });
  });

  it('dedupes and ignores blank lines', () => {
    expect(parseAgyModels('Gemini 3.1 Pro (High)\n\nGemini 3.1 Pro (High)\n').map((m) => m.value)).toEqual([
      'Gemini 3.1 Pro (High)',
    ]);
  });
});

describe('antigravityModelsService', () => {
  it('runs agy models via PTY, parses + caches the list', async () => {
    const spawnPty = vi.fn(() => fakePty([RAW_OUTPUT]));
    const svc = createAntigravityModelsService({
      resolveBinary: () => 'agy',
      spawnPty,
      ttlMs: 10_000,
      now: () => 1000,
    });
    await svc.warm(); // populate cache
    const opts = await svc.getModelOptions();
    expect(opts?.map((m) => m.value)).toEqual(EXPECTED);
  });

  it('getModelOptions is non-blocking: returns null on a cold cache while refreshing', async () => {
    let resolveExit: (() => void) | null = null;
    const slowPty: PtyProc = {
      onData: () => {},
      onExit: (cb) => { resolveExit = cb; }, // never fires until we say so
      kill: () => {},
    };
    const svc = createAntigravityModelsService({ resolveBinary: () => 'agy', spawnPty: () => slowPty });
    expect(await svc.getModelOptions()).toBeNull(); // cold → immediate null, refresh in flight
    expect(resolveExit).not.toBeNull(); // a fetch was started
  });

  it('falls back to null when the PTY yields no parseable models', async () => {
    const svc = createAntigravityModelsService({
      resolveBinary: () => 'agy',
      spawnPty: () => fakePty(['⠋ Fetching available models...\r\n']),
    });
    await svc.warm();
    expect(await svc.getModelOptions()).toBeNull();
  });

  it('serves the cache within TTL without re-spawning', async () => {
    const spawnPty = vi.fn(() => fakePty([RAW_OUTPUT]));
    const svc = createAntigravityModelsService({
      resolveBinary: () => 'agy',
      spawnPty,
      ttlMs: 10_000,
      now: () => 1000,
    });
    await svc.warm();
    await svc.getModelOptions();
    await svc.getModelOptions();
    expect(spawnPty).toHaveBeenCalledTimes(1);
  });
});
