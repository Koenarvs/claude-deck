import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGunzip } from 'node:zlib';
import { createTarStream, createMultiSessionTarStream, createTarGzStream } from '../../server/tar-utils';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-utils-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Collects a readable stream into a single Buffer. */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Minimal tar parser that extracts file entries from a tar buffer.
 * Returns an array of { name, content } objects.
 */
function parseTar(buf: Buffer): Array<{ name: string; content: string }> {
  const BLOCK = 512;
  const entries: Array<{ name: string; content: string }> = [];
  let offset = 0;

  while (offset + BLOCK <= buf.byteLength) {
    const header = buf.subarray(offset, offset + BLOCK);

    // Check for end-of-archive (all zeros)
    if (header.every((b) => b === 0)) break;

    // Extract name (bytes 0-99, null-terminated)
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, Math.min(nameEnd, 100)).toString('utf-8');

    // Extract size (bytes 124-135, octal, null-terminated)
    const sizeStr = header.subarray(124, 135).toString('utf-8').trim();
    const size = parseInt(sizeStr, 8);

    // Content follows header
    offset += BLOCK;
    const content = buf.subarray(offset, offset + size).toString('utf-8');
    entries.push({ name, content });

    // Advance past content + padding to next block boundary
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return entries;
}

describe('tar-utils', () => {
  describe('createTarStream', () => {
    it('produces a valid tar archive with directory contents', async () => {
      const dir = path.join(tmpDir, 'session');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stream.jsonl'), '{"type":"init"}\n');
      fs.writeFileSync(path.join(dir, 'hooks.jsonl'), '{"event":"hook"}\n');
      fs.writeFileSync(path.join(dir, 'stderr.log'), 'error\n');

      const stream = createTarStream(dir, 'my-session/');
      const buf = await streamToBuffer(stream);

      const entries = parseTar(buf);
      expect(entries).toHaveLength(3);

      const names = entries.map((e) => e.name);
      expect(names).toContain('my-session/stream.jsonl');
      expect(names).toContain('my-session/hooks.jsonl');
      expect(names).toContain('my-session/stderr.log');

      const streamEntry = entries.find((e) => e.name === 'my-session/stream.jsonl');
      expect(streamEntry?.content).toBe('{"type":"init"}\n');
    });

    it('produces an empty archive for non-existent directory', async () => {
      const stream = createTarStream('/nonexistent/path', 'prefix/');
      const buf = await streamToBuffer(stream);
      // Should just contain end-of-archive marker or be empty
      expect(buf.byteLength).toBeLessThanOrEqual(1024);
    });
  });

  describe('createMultiSessionTarStream', () => {
    it('includes files from multiple session directories', async () => {
      const dir1 = path.join(tmpDir, 's1');
      const dir2 = path.join(tmpDir, 's2');
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir1, 'stream.jsonl'), 'session1\n');
      fs.writeFileSync(path.join(dir2, 'stream.jsonl'), 'session2\n');

      const stream = createMultiSessionTarStream([
        { sessionId: 's1', dirPath: dir1 },
        { sessionId: 's2', dirPath: dir2 },
      ]);
      const buf = await streamToBuffer(stream);

      const entries = parseTar(buf);
      expect(entries).toHaveLength(2);
      expect(entries[0]?.name).toBe('s1/stream.jsonl');
      expect(entries[0]?.content).toBe('session1\n');
      expect(entries[1]?.name).toBe('s2/stream.jsonl');
      expect(entries[1]?.content).toBe('session2\n');
    });

    it('skips non-existent session directories', async () => {
      const dir1 = path.join(tmpDir, 's1');
      fs.mkdirSync(dir1, { recursive: true });
      fs.writeFileSync(path.join(dir1, 'stream.jsonl'), 'data\n');

      const stream = createMultiSessionTarStream([
        { sessionId: 's1', dirPath: dir1 },
        { sessionId: 's2', dirPath: '/nonexistent' },
      ]);
      const buf = await streamToBuffer(stream);

      const entries = parseTar(buf);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe('s1/stream.jsonl');
    });
  });

  describe('createTarGzStream', () => {
    it('produces valid gzip-compressed tar data', async () => {
      const dir = path.join(tmpDir, 'session');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'stream.jsonl'), '{"test":true}\n');

      const gzStream = createTarGzStream(dir, 'prefix/');
      const gzBuf = await streamToBuffer(gzStream);

      // Verify gzip magic number
      expect(gzBuf[0]).toBe(0x1f);
      expect(gzBuf[1]).toBe(0x8b);

      // Decompress and verify tar contents
      const gunzip = createGunzip();
      const tarBuf = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
        gunzip.on('end', () => resolve(Buffer.concat(chunks)));
        gunzip.on('error', reject);
        gunzip.end(gzBuf);
      });

      const entries = parseTar(tarBuf);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe('prefix/stream.jsonl');
      expect(entries[0]?.content).toBe('{"test":true}\n');
    });
  });
});
