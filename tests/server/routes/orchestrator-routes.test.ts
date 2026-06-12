import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import { makeMigratedDb } from '../helpers/db-fixture';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import { createOrchestratorRouter } from '../../../server/routes/orchestrator';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let server: http.Server;
let port: number;
let trigger: ReturnType<typeof vi.fn>;
let ratify: ReturnType<typeof vi.fn>;
const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;

beforeEach(async () => {
  db = makeMigratedDb();
  const stateService = new OrchestratorStateService(db);
  const messageService = new OrchestratorMessageService(db);
  trigger = vi.fn(async () => {});
  ratify = vi.fn(() => true);

  const app = express();
  app.use(express.json());
  app.use('/api', createOrchestratorRouter({ stateService, messageService, trigger, ratifyApproval: ratify }));
  server = http.createServer(app);
  port = await new Promise<number>((resolve) =>
    server.listen(0, () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? addr.port : 0);
    }),
  );
});
afterEach(() => {
  server.close();
  db.close();
});

describe('orchestrator routes', () => {
  it('GET /api/orchestrator returns state + messages', async () => {
    const res = await fetch(url('/orchestrator'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { config: { persona_name: string } }; messages: unknown[] };
    expect(body.state.config.persona_name).toBe('Hawat');
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('POST /api/orchestrator/messages triggers the service and returns 202', async () => {
    const res = await fetch(url('/orchestrator/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'status?' }),
    });
    expect(res.status).toBe(202);
    expect(trigger).toHaveBeenCalledWith({ kind: 'owner_message', text: 'status?', channel: 'app' });
  });

  it('POST /api/orchestrator/messages rejects empty text with 400', async () => {
    const res = await fetch(url('/orchestrator/messages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT /api/orchestrator/config updates and returns the new config', async () => {
    const res = await fetch(url('/orchestrator/config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, persona_name: 'Thufir' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { persona_name: string }).persona_name).toBe('Thufir');
  });

  it('POST /api/orchestrator/decision ratifies via the coordinator', async () => {
    const res = await fetch(url('/orchestrator/decision'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId: 'a1', decision: 'approved' }),
    });
    expect(res.status).toBe(200);
    expect(ratify).toHaveBeenCalledWith('a1', 'approved', undefined);
  });
});
