import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDocWriter } from '../../../server/services/doc-writer';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dir: string;
let file: string;
const dw = createDocWriter();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docwriter-'));
  file = path.join(dir, 'handoff.md');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('DocWriter', () => {
  it('readWithBase reports a non-existent file with empty hash', () => {
    const r = dw.readWithBase(file);
    expect(r.exists).toBe(false);
    expect(r.baseHash).toBe('');
  });

  it('writes a new file (baseHash "") with an attribution trailer', () => {
    const r = dw.writeWithAttribution({ path: file, content: 'hello\n', baseHash: '', author: 'goal-42/codex' });
    expect(r.written).toBe(true);
    expect(r.conflict).toBe(false);
    const onDisk = fs.readFileSync(file, 'utf-8');
    expect(onDisk).toMatch(/— written by goal-42\/codex @ \d{4}-\d{2}-\d{2}T/);
  });

  it('round-trips: readWithBase then write with the matching hash succeeds', () => {
    fs.writeFileSync(file, 'original\n');
    const base = dw.readWithBase(file);
    const r = dw.writeWithAttribution({ path: file, content: 'updated\n', baseHash: base.baseHash, author: 'goal-1/claude' });
    expect(r.written).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toContain('updated');
  });

  it('detects a conflict when the file changed since read (last-write-wins)', () => {
    fs.writeFileSync(file, 'original\n');
    const base = dw.readWithBase(file);
    fs.writeFileSync(file, 'someone-else-wrote\n'); // disk changes after the read
    const r = dw.writeWithAttribution({ path: file, content: 'mine\n', baseHash: base.baseHash, author: 'goal-1/claude' });
    expect(r.conflict).toBe(true);
    expect(r.written).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('someone-else-wrote\n'); // untouched
  });

  it('does not double-stamp when the content already ends with a trailer', () => {
    const content = 'updated\n\n— written by goal-9/claude @ 2026-06-09T00:00:00.000Z\n';
    dw.writeWithAttribution({ path: file, content, baseHash: '', author: 'goal-1/claude' });
    const onDisk = fs.readFileSync(file, 'utf-8');
    expect((onDisk.match(/— written by/g) ?? []).length).toBe(1);
  });
});
