import { describe, it, expect } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createApiAuthMiddleware } from '../../../server/middleware/auth';

function appWith(token: string | null): { server: http.Server; portP: Promise<number> } {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiAuthMiddleware({ token }));
  app.get('/api/health', (_req, res) => res.json({ ok: true })); // exempt
  app.get('/api/secret', (_req, res) => res.json({ data: 42 }));
  const server = http.createServer(app);
  const portP = new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );
  return { server, portP };
}

describe('API auth middleware', () => {
  it('allows everything when no token is configured (loopback dev)', async () => {
    const { server, portP } = appWith(null);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`);
    expect(res.status).toBe(200);
    server.close();
  });

  it('401s a protected route with no Authorization header when token required', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`);
    expect(res.status).toBe(401);
    server.close();
  });

  it('allows a protected route with the correct Bearer token', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`, {
      headers: { Authorization: 'Bearer s3cret' },
    });
    expect(res.status).toBe(200);
    server.close();
  });

  it('401s a protected route with a wrong token', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
    server.close();
  });

  it('exempts /api/health even when a token is required', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    server.close();
  });

  it('accepts the token via X-Claude-Deck-Token header (for the hook client)', async () => {
    const { server, portP } = appWith('s3cret');
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/secret`, {
      headers: { 'X-Claude-Deck-Token': 's3cret' },
    });
    expect(res.status).toBe(200);
    server.close();
  });
});
