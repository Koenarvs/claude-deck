import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../../server/app';

const app = createApp();
const server = http.createServer(app);

function startServer(): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      }
    });
  });
}

let port: number;

describe('Express app', () => {
  afterAll(() => {
    server.close();
  });

  it('GET /api/health returns 200 with ok:true', async () => {
    port = await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe('number');
  });

  it('unknown route returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/nonexistent`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(body.error).toBe('Not found');
  });
});
