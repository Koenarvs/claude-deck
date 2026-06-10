import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardApiClient } from '../../mcp/src/api-client';

let server: http.Server | null = null;
afterEach(() => { if (server) { server.close(); server = null; } });

function echoServer(): Promise<{ port: number; lastAuth: () => string | undefined }> {
  let last: string | undefined;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      last = req.headers['authorization'] as string | undefined;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([])); // listGoals expects an array
    });
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      resolve({ port: typeof a === 'object' && a ? a.port : 0, lastAuth: () => last });
    });
  });
}

describe('MCP DashboardApiClient token passthrough', () => {
  it('sends Bearer token when CLAUDE_DECK_TOKEN is set', async () => {
    const { port, lastAuth } = await echoServer();
    const prev = process.env['CLAUDE_DECK_TOKEN'];
    process.env['CLAUDE_DECK_TOKEN'] = 'mcp-secret';
    try {
      const client = new DashboardApiClient(`http://127.0.0.1:${port}`);
      await client.listGoals();
      expect(lastAuth()).toBe('Bearer mcp-secret');
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_DECK_TOKEN'];
      else process.env['CLAUDE_DECK_TOKEN'] = prev;
    }
  });

  it('sends no auth header when token unset', async () => {
    const { port, lastAuth } = await echoServer();
    const prev = process.env['CLAUDE_DECK_TOKEN'];
    delete process.env['CLAUDE_DECK_TOKEN'];
    try {
      const client = new DashboardApiClient(`http://127.0.0.1:${port}`);
      await client.listGoals();
      expect(lastAuth()).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env['CLAUDE_DECK_TOKEN'] = prev;
    }
  });
});
