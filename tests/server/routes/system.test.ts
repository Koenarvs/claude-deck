import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import systemRouter from '../../../server/routes/system';

/**
 * Integration tests for the hook installer HTTP endpoints.
 * Tests POST /api/system/install-hooks, POST /api/system/uninstall-hooks,
 * and GET /api/system/hook-status by standing up a real Express server.
 *
 * NOTE: The routes call hookInstallerService which operates on the real
 * ~/.claude/settings.json. The service-level tests in
 * hook-installer-service.test.ts use temp directories for isolation.
 * These route tests verify the HTTP contract (status codes, response shapes).
 */

function createTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', systemRouter);
  return app;
}

describe('System routes (HTTP endpoints)', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const app = createTestApp();
    server = http.createServer(app);
    port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        }
      });
    });
  });

  afterEach(() => {
    server.close();
  });

  // ── QA-7: POST /api/system/install-hooks ─────────────────────────────────

  describe('POST /api/system/install-hooks', () => {
    it('returns 200 with { installed: true }', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/system/install-hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.installed).toBe(true);
    });
  });

  describe('POST /api/system/uninstall-hooks', () => {
    it('returns 200 with uninstalled field', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/system/uninstall-hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.uninstalled).toBe('boolean');
    });
  });

  describe('GET /api/system/hook-status', () => {
    it('returns 200 with installed and installedAt fields', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/system/hook-status`);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.installed).toBe('boolean');
      expect(body.installedAt === null || typeof body.installedAt === 'number').toBe(true);
    });
  });
});
