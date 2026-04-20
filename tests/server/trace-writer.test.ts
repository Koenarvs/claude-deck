import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TraceWriter } from '../../server/trace-writer';

let tmpDir: string;
let traceDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-writer-test-'));
  traceDir = path.join(tmpDir, 'test-session');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TraceWriter', () => {
  it('creates trace directory on construction', () => {
    const writer = new TraceWriter('s1', traceDir);
    expect(fs.existsSync(traceDir)).toBe(true);
    writer.close();
  });

  it('creates stream.jsonl, hooks.jsonl, and stderr.log files', async () => {
    const writer = new TraceWriter('s1', traceDir);
    writer.appendStream('{"type":"init"}');
    writer.appendHook({ event_type: 'SessionStart' });
    writer.appendStderr('warning\n');
    await writer.close();

    expect(fs.existsSync(path.join(traceDir, 'stream.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(traceDir, 'hooks.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(traceDir, 'stderr.log'))).toBe(true);
  });

  describe('appendStream', () => {
    it('appends lines to stream.jsonl with trailing newline', async () => {
      const writer = new TraceWriter('s1', traceDir);
      writer.appendStream('{"type":"init"}');
      writer.appendStream('{"type":"assistant"}\n');
      await writer.close();

      const content = fs.readFileSync(path.join(traceDir, 'stream.jsonl'), 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('{"type":"init"}');
      expect(lines[1]).toBe('{"type":"assistant"}');
    });

    it('increments stream_event_count', async () => {
      const writer = new TraceWriter('s1', traceDir);
      for (let i = 0; i < 100; i++) {
        writer.appendStream(`{"i":${i}}`);
      }
      expect(writer.streamEventCount).toBe(100);
      await writer.close();
    });

    it('handles 1000 events correctly (QA-1)', async () => {
      const writer = new TraceWriter('s1', traceDir);
      for (let i = 0; i < 1000; i++) {
        writer.appendStream(`{"event":${i}}`);
      }
      await writer.close();

      expect(writer.streamEventCount).toBe(1000);

      const content = fs.readFileSync(path.join(traceDir, 'stream.jsonl'), 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1000);
    });
  });

  describe('appendHook', () => {
    it('appends JSON objects to hooks.jsonl', async () => {
      const writer = new TraceWriter('s1', traceDir);
      const payload = { event_type: 'PreToolUse', tool_name: 'Bash', session_id: 's1' };
      writer.appendHook(payload);
      await writer.close();

      const content = fs.readFileSync(path.join(traceDir, 'hooks.jsonl'), 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual(payload);
    });

    it('increments hook_event_count', async () => {
      const writer = new TraceWriter('s1', traceDir);
      for (let i = 0; i < 50; i++) {
        writer.appendHook({ i });
      }
      expect(writer.hookEventCount).toBe(50);
      await writer.close();
    });
  });

  describe('appendStderr', () => {
    it('appends raw text to stderr.log', async () => {
      const writer = new TraceWriter('s1', traceDir);
      writer.appendStderr('error line 1\n');
      writer.appendStderr('error line 2\n');
      await writer.close();

      const content = fs.readFileSync(path.join(traceDir, 'stderr.log'), 'utf-8');
      expect(content).toBe('error line 1\nerror line 2\n');
    });

    it('increments stderr_bytes by byte length', async () => {
      const writer = new TraceWriter('s1', traceDir);
      const chunk = 'hello world\n';
      writer.appendStderr(chunk);
      expect(writer.stderrBytes).toBe(Buffer.from(chunk, 'utf-8').byteLength);
      await writer.close();
    });

    it('counts multi-byte unicode correctly', async () => {
      const writer = new TraceWriter('s1', traceDir);
      const chunk = '\u{1F600}\u{1F4A9}'; // two 4-byte emoji
      writer.appendStderr(chunk);
      expect(writer.stderrBytes).toBe(Buffer.from(chunk, 'utf-8').byteLength);
      await writer.close();
    });
  });

  describe('writeMeta', () => {
    it('writes meta.json with formatted JSON', async () => {
      const writer = new TraceWriter('s1', traceDir);
      const meta = { session_id: 's1', stream_event_count: 42, ended_at: Date.now() };
      await writer.writeMeta(meta);
      await writer.close();

      const content = fs.readFileSync(path.join(traceDir, 'meta.json'), 'utf-8');
      expect(JSON.parse(content)).toEqual(meta);
    });
  });

  describe('close', () => {
    it('is idempotent (QA-2 partial)', async () => {
      const writer = new TraceWriter('s1', traceDir);
      writer.appendStream('{"a":1}');
      await writer.close();
      await writer.close(); // should not throw

      expect(writer.closed).toBe(true);
    });

    it('prevents further writes after close', async () => {
      const writer = new TraceWriter('s1', traceDir);
      await writer.close();

      expect(() => writer.appendStream('{"a":1}')).toThrow(/closed/);
      expect(() => writer.appendHook({ a: 1 })).toThrow(/closed/);
      expect(() => writer.appendStderr('x')).toThrow(/closed/);
    });

    it('data survives close and is readable (QA-2)', async () => {
      const writer = new TraceWriter('s1', traceDir);
      writer.appendStream('{"before":"close"}');
      await writer.close();

      const content = fs.readFileSync(path.join(traceDir, 'stream.jsonl'), 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual({ before: 'close' });
    });
  });

  describe('fidelity', () => {
    it('preserves unicode, escaped newlines, and large strings', async () => {
      const writer = new TraceWriter('s1', traceDir);

      const events = [
        { type: 'text', text: 'Hello \u{1F600}' },
        { type: 'text', text: 'Line with\\nnewline escape' },
        { type: 'text', text: 'Tab\\there' },
        { type: 'text', text: '\u00E9\u00E8\u00EA' }, // accented chars
        { type: 'text', text: '\u4E16\u754C' }, // CJK
        { type: 'text', text: 'embedded "quotes" and \\backslashes\\' },
        { type: 'tool_result', content: 'x'.repeat(10000) }, // large string
        { type: 'text', text: '\t\r\n' }, // control chars (JSON-escaped by stringify)
        { type: 'text', text: '' }, // empty string
        { type: 'complex', data: { nested: [1, 2, { deep: true }] } },
      ];

      for (const event of events) {
        writer.appendStream(JSON.stringify(event));
      }
      await writer.close();

      // Read back and verify byte-identical reconstruction
      const content = fs.readFileSync(path.join(traceDir, 'stream.jsonl'), 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(events.length);

      for (let i = 0; i < events.length; i++) {
        const parsed = JSON.parse(lines[i]!);
        expect(parsed).toEqual(events[i]);
      }
    });

    it('fidelity test with 100 synthetic events (acceptance criteria)', async () => {
      const writer = new TraceWriter('s1', traceDir);

      const events: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 100; i++) {
        const event: Record<string, unknown> = {
          type: i % 3 === 0 ? 'text' : i % 3 === 1 ? 'tool_use' : 'tool_result',
          index: i,
          unicode: `\u{1F600}_${i}_\u4E16\u754C`,
          escaped_newline: `line1\\nline2_${i}`,
          large_content: 'A'.repeat(1000 + i),
          nested: { arr: [i, i + 1], obj: { deep: true, val: i } },
        };
        events.push(event);
        writer.appendStream(JSON.stringify(event));
      }
      await writer.close();

      const content = fs.readFileSync(path.join(traceDir, 'stream.jsonl'), 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(100);

      for (let i = 0; i < 100; i++) {
        const parsed = JSON.parse(lines[i]!);
        expect(parsed).toEqual(events[i]);
      }
    });
  });

  describe('throughput (QA-5)', () => {
    it('sustains 1000 appends of 1KB each without blocking', async () => {
      const writer = new TraceWriter('s1', traceDir);
      const payload = JSON.stringify({ data: 'x'.repeat(1024 - 20) }); // ~1KB

      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        writer.appendStream(payload);
      }
      const elapsed = performance.now() - start;
      await writer.close();

      // 1000 * 1KB = ~1MB should complete well under 10s
      expect(elapsed).toBeLessThan(10000);
      expect(writer.streamEventCount).toBe(1000);
    });
  });
});
