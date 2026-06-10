import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const onDataCbs: Array<(d: string) => void> = [];
const onExitCbs: Array<(e: { exitCode: number }) => void> = [];
vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: (cb: (d: string) => void) => onDataCbs.push(cb),
    onExit: (cb: (e: { exitCode: number }) => void) => onExitCbs.push(cb),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  }),
}));

import { PtyManager } from '../../server/pty-manager';
import { ClaudeAdapter } from '../../server/agents/claude-adapter';
import type { Goal } from '../../src/shared/types';

describe('PtyManager trace writing', () => {
  beforeEach(() => { onDataCbs.length = 0; onExitCbs.length = 0; });

  it('writes stream.jsonl and meta.json to traceDir over the session lifecycle', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
    const traceDir = path.join(tmp, 'goal-1');
    const goal = { id: 'goal-1', cwd: tmp, permission_mode: 'supervised', model: 'default' } as Goal;
    const mgr = new PtyManager(goal, new ClaudeAdapter(), { broadcast: vi.fn(), traceDir });

    mgr.start();
    onDataCbs.forEach((cb) => cb('{"type":"x"}\n'));
    onExitCbs.forEach((cb) => cb({ exitCode: 0 }));
    await new Promise((r) => setTimeout(r, 40)); // allow async writeMeta/close

    expect(fs.existsSync(path.join(traceDir, 'stream.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(traceDir, 'stream.jsonl'), 'utf-8')).toContain('"type":"x"');
    expect(fs.existsSync(path.join(traceDir, 'meta.json'))).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
