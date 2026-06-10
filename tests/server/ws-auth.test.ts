import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { setupWss } from '../../server/ws';

let server: http.Server | null = null;

function start(opts: { token: string | null; allowedOrigins: string[] }): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    setupWss(srv, opts);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      server = srv;
      resolve(typeof a === 'object' && a ? a.port : 0);
    });
  });
}

function tryConnect(url: string, headers?: Record<string, string>, protocols?: string): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocols, headers ? { headers } : undefined);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(-1));
  });
}

afterEach(() => { if (server) { server.close(); server = null; } });

describe('WebSocket upgrade auth', () => {
  it('accepts any connection when no token configured (loopback dev)', async () => {
    const port = await start({ token: null, allowedOrigins: [] });
    const result = await tryConnect(`ws://127.0.0.1:${port}/ws`);
    expect(result).toBe('open');
  });

  it('rejects a connection with a bad Origin even on loopback', async () => {
    const port = await start({ token: null, allowedOrigins: ['http://localhost:5173'] });
    const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, { Origin: 'http://evil.example' });
    expect(result).not.toBe('open'); // 401/403 or socket error
  });

  it('rejects a connection with no token when a token is required', async () => {
    const port = await start({ token: 's3cret', allowedOrigins: ['http://localhost:5173'] });
    const result = await tryConnect(`ws://127.0.0.1:${port}/ws`, { Origin: 'http://localhost:5173' });
    expect(result).not.toBe('open');
  });

  it('accepts a connection with the token via query param', async () => {
    const port = await start({ token: 's3cret', allowedOrigins: ['http://localhost:5173'] });
    const result = await tryConnect(
      `ws://127.0.0.1:${port}/ws?token=s3cret`,
      { Origin: 'http://localhost:5173' },
    );
    expect(result).toBe('open');
  });

  it('accepts a connection with the token via subprotocol', async () => {
    const port = await start({ token: 's3cret', allowedOrigins: ['http://localhost:5173'] });
    const result = await tryConnect(
      `ws://127.0.0.1:${port}/ws`,
      { Origin: 'http://localhost:5173' },
      'claude-deck-token.s3cret',
    );
    expect(result).toBe('open');
  });
});
