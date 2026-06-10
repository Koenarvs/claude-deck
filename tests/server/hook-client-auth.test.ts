import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

let server: http.Server | null = null;
afterEach(() => { if (server) { server.close(); server = null; } });

function echoServer(): Promise<{ port: number; received: Promise<string | undefined> }> {
  let resolveHdr: (v: string | undefined) => void;
  const received = new Promise<string | undefined>((r) => (resolveHdr = r));
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      resolveHdr(req.headers['x-claude-deck-token'] as string | undefined);
      res.end(JSON.stringify({ ok: true }));
    });
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      resolve({ port: typeof a === 'object' && a ? a.port : 0, received });
    });
  });
}

describe('hooks/client.js token passthrough', () => {
  it('sends X-Claude-Deck-Token when CLAUDE_DECK_TOKEN set', async () => {
    const { port, received } = await echoServer();
    const script = path.resolve(process.cwd(), 'hooks', 'client.js');
    const child = spawn(process.execPath, [script, 'post-tool-use'], {
      env: { ...process.env, CLAUDE_DECK_PORT: String(port), CLAUDE_DECK_HOST: '127.0.0.1', CLAUDE_DECK_TOKEN: 'hook-secret' },
    });
    child.stdin.write(JSON.stringify({ hook_event_name: 'PostToolUse' }));
    child.stdin.end();
    const hdr = await received;
    expect(hdr).toBe('hook-secret');
  });
});
