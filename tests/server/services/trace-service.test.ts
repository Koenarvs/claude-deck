import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TraceService } from '../../../server/services/trace-service';

let tmpDir: string;
let service: TraceService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-service-test-'));
  service = new TraceService(tmpDir);
});

afterEach(async () => {
  await service.closeAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TraceService', () => {
  describe('getOrCreate', () => {
    it('creates a new TraceWriter for an unknown session', () => {
      const writer = service.getOrCreate('s1');
      expect(writer).toBeDefined();
      expect(writer.sessionId).toBe('s1');
      expect(writer.closed).toBe(false);
    });

    it('returns the same writer on subsequent calls', () => {
      const w1 = service.getOrCreate('s1');
      const w2 = service.getOrCreate('s1');
      expect(w1).toBe(w2);
    });

    it('creates the trace directory under dataDir/traces/<sessionId>', () => {
      service.getOrCreate('s1');
      const expected = path.join(tmpDir, 'traces', 's1');
      expect(fs.existsSync(expected)).toBe(true);
    });

    it('creates a new writer if the existing one is closed', async () => {
      const w1 = service.getOrCreate('s1');
      await w1.close();

      const w2 = service.getOrCreate('s1');
      expect(w2).not.toBe(w1);
      expect(w2.closed).toBe(false);
    });
  });

  describe('get', () => {
    it('returns undefined for unknown sessions', () => {
      expect(service.get('unknown')).toBeUndefined();
    });

    it('returns the writer for a known session', () => {
      const writer = service.getOrCreate('s1');
      expect(service.get('s1')).toBe(writer);
    });

    it('returns undefined for closed writers', async () => {
      const writer = service.getOrCreate('s1');
      await writer.close();
      expect(service.get('s1')).toBeUndefined();
    });
  });

  describe('closeSession', () => {
    it('closes and removes the writer', async () => {
      service.getOrCreate('s1');
      expect(service.openCount).toBe(1);

      await service.closeSession('s1');
      expect(service.openCount).toBe(0);
      expect(service.get('s1')).toBeUndefined();
    });

    it('is safe to call for non-existent sessions', async () => {
      await expect(service.closeSession('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('closeAll', () => {
    it('closes all open writers', async () => {
      service.getOrCreate('s1');
      service.getOrCreate('s2');
      service.getOrCreate('s3');
      expect(service.openCount).toBe(3);

      await service.closeAll();
      expect(service.openCount).toBe(0);
    });
  });

  describe('getTraceDir', () => {
    it('returns the expected path without creating it', () => {
      const dir = service.getTraceDir('s1');
      expect(dir).toBe(path.join(tmpDir, 'traces', 's1'));
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  describe('traceDirExists', () => {
    it('returns false when trace dir does not exist', () => {
      expect(service.traceDirExists('s1')).toBe(false);
    });

    it('returns true after getOrCreate creates the dir', () => {
      service.getOrCreate('s1');
      expect(service.traceDirExists('s1')).toBe(true);
    });
  });

  describe('EMFILE eviction', () => {
    it('evicts the oldest writer when capacity is reached', async () => {
      // Create enough writers to trigger eviction (MAX_OPEN_WRITERS = 100)
      // We test with a smaller count to verify the eviction mechanism works
      // by checking that getOrCreate succeeds beyond capacity.
      // The actual MAX_OPEN_WRITERS is 100, which would open 300 file descriptors.
      // For testing, we verify the behavior pattern: creating 101 writers
      // should evict the first one.

      // Create 100 writers
      for (let i = 0; i < 100; i++) {
        service.getOrCreate(`session-${i}`);
      }
      expect(service.openCount).toBe(100);

      // The 101st should trigger eviction of session-0
      service.getOrCreate('session-100');

      // openCount should still be 100 (evicted one, added one)
      expect(service.openCount).toBe(100);
    });
  });

  describe('data persistence through service', () => {
    it('writes via getOrCreate are persisted to disk', async () => {
      const writer = service.getOrCreate('s1');
      writer.appendStream('{"type":"test"}');
      writer.appendHook({ event: 'hook' });
      writer.appendStderr('stderr output');
      await service.closeSession('s1');

      const streamContent = fs.readFileSync(
        path.join(tmpDir, 'traces', 's1', 'stream.jsonl'),
        'utf-8',
      );
      const hooksContent = fs.readFileSync(
        path.join(tmpDir, 'traces', 's1', 'hooks.jsonl'),
        'utf-8',
      );
      const stderrContent = fs.readFileSync(
        path.join(tmpDir, 'traces', 's1', 'stderr.log'),
        'utf-8',
      );

      expect(streamContent.trim()).toBe('{"type":"test"}');
      expect(JSON.parse(hooksContent.trim())).toEqual({ event: 'hook' });
      expect(stderrContent).toBe('stderr output');
    });
  });
});
