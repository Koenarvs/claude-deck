import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { makeMigratedDb } from '../helpers/db-fixture';
import { createBudgetService } from '../../../server/services/budget-service';
import { createBudgetRouter } from '../../../server/routes/budget';
import type Database from 'better-sqlite3';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let server: http.Server;
let port: number;
const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;
const post = (p: string, body: unknown) =>
  fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  db = makeMigratedDb();
  const svc = createBudgetService(db, () => ({
    providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { dailyUsd: 50 } }],
  }));
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createBudgetRouter(svc, {
      activeSessionsByProvider: () => ({ claude: 0 }),
      fetchWindowUtilization: async () => [
        { provider: 'claude', utilizationPct: 90 },
        { provider: 'codex', utilizationPct: 10 },
      ],
      enabledProviders: () => ['claude', 'codex'],
      routingConfig: () => ({ hotThresholdPct: 85, autoRoute: false }),
      readConfig: () => ({
        providers: [{ id: 'claude', enabled: true, billingMode: 'metered', budget: { dailyUsd: 50 } }],
      }),
    }),
  );
  server = http.createServer(app);
  port = await new Promise<number>((r) =>
    server.listen(0, () => {
      const a = server.address();
      if (a && typeof a === 'object') r(a.port);
    }),
  );
});
afterEach(() => {
  server.close();
  db.close();
});

describe('budget routes', () => {
  it('GET /api/budget/status returns kill switch + provider rows', async () => {
    const res = await fetch(url('/budget/status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      killSwitchActive: boolean;
      providers: Array<{ id: string; dailyCapUsd: number }>;
    };
    expect(body.killSwitchActive).toBe(false);
    expect(body.providers.find((p) => p.id === 'claude')?.dailyCapUsd).toBe(50);
  });

  it('POST /api/budget/kill-switch flips the switch', async () => {
    const res = await post('/budget/kill-switch', { active: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { killSwitchActive: boolean }).killSwitchActive).toBe(true);
    const status = (await (await fetch(url('/budget/status'))).json()) as { killSwitchActive: boolean };
    expect(status.killSwitchActive).toBe(true);
  });

  it('GET /api/routing/recommendation advises a cooler provider when hot', async () => {
    const res = await fetch(url('/routing/recommendation?model=opus'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recommendedProvider: string | null; applied: boolean };
    expect(body.recommendedProvider).toBe('codex');
    expect(body.applied).toBe(false);
  });
});
