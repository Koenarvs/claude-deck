import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import { createClientErrorsRouter } from '../../../server/routes/client-errors';
import logger from '../../../server/logger';

let server: http.Server | null = null;
afterEach(() => {
  if (server) {
    server.close();
    server = null;
  }
  vi.restoreAllMocks();
});

function start(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createClientErrorsRouter());
  const srv = http.createServer(app);
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    }),
  );
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/client-errors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/client-errors', () => {
  it('logs a valid report and returns 204', async () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const base = await start();
    const res = await post(base, {
      message: 'boom',
      stack: 'Error: boom\n  at x',
      source: 'error-boundary',
      url: 'http://localhost/board',
    });
    expect(res.status).toBe(204);
    expect(errSpy).toHaveBeenCalledOnce();
    const [ctx, msg] = errSpy.mock.calls[0]! as [Record<string, unknown>, string];
    expect(ctx['client']).toBe(true);
    expect(ctx['source']).toBe('error-boundary');
    expect(msg).toContain('boom');
  });

  it('rejects an invalid payload with 400 and logs nothing', async () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const base = await start();
    const res = await post(base, { nope: true });
    expect(res.status).toBe(400);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('rejects an oversized message', async () => {
    const base = await start();
    const res = await post(base, { message: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
  });
});
