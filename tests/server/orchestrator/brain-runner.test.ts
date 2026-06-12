import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { BrainRunner } from '../../../server/orchestrator/brain-runner';
import { ClaudeBrainProvider, type BrainStreamEvent } from '../../../server/orchestrator/brain-provider';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Builds a fake child process whose stdout emits the given lines then exits. */
function fakeChild(lines: string[], exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: () => void;
  };
  child.stdout = Readable.from(lines.map((l) => l + '\n'));
  child.stderr = Readable.from([]);
  child.kill = vi.fn();
  child.stdout.on('end', () => setImmediate(() => child.emit('close', exitCode)));
  return child;
}

describe('BrainRunner', () => {
  it('streams text events and returns the full text + extracted memory', async () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All green. ' }] } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '<memory-update>\n# Orchestrator Memory\nWatching g1.\n</memory-update>' }] },
      }),
      JSON.stringify({ type: 'result', result: 'ok' }),
    ];
    const spawnFn = vi.fn(() => fakeChild(lines));
    const events: BrainStreamEvent[] = [];
    const runner = new BrainRunner(new ClaudeBrainProvider('claude'), { spawnFn, silenceTimeoutMs: 1000 });

    const result = await runner.run(
      { prompt: 'p', model: 'haiku', mcpConfigJson: '{}', permissionMode: 'supervised' },
      (e) => events.push(e),
    );

    expect(spawnFn).toHaveBeenCalledOnce();
    expect(events.some((e) => e.kind === 'text' && e.text.includes('All green'))).toBe(true);
    expect(result.fullText).toContain('All green');
    expect(result.memory).toBe('# Orchestrator Memory\nWatching g1.');
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
  });

  it('reports a non-zero exit as ok=false', async () => {
    const spawnFn = vi.fn(() => fakeChild([], 1));
    const runner = new BrainRunner(new ClaudeBrainProvider('claude'), { spawnFn, silenceTimeoutMs: 1000 });
    const result = await runner.run(
      { prompt: 'p', model: 'haiku', mcpConfigJson: '{}', permissionMode: 'supervised' },
      () => {},
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});
