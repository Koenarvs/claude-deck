// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import { createOrchestratorChannelsRouter } from '../../../server/routes/orchestrator-channels';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('orchestrator channel ingress', () => {
  let server: http.Server;
  let port: number;
  let trigger: ReturnType<typeof vi.fn>;
  let stateService: OrchestratorStateService;
  const url = (p: string) => `http://127.0.0.1:${port}/api${p}`;

  beforeEach(async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    stateService = new OrchestratorStateService(db);
    stateService.updateConfig({ enabled: true, discord_owner_id: 'owner-1' });
    trigger = vi.fn(async () => {});

    const app = express();
    app.use(express.json());
    app.use('/api', createOrchestratorChannelsRouter({ stateService, trigger }));

    port = await new Promise<number>((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const addr = server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : 0);
      });
    });
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (body: unknown) =>
    fetch(url('/orchestrator/channels/discord/inbound'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  it('triggers an owner_message on the discord channel for the paired owner', async () => {
    const res = await post({ userId: 'owner-1', chatId: 'dm-9', text: 'status?', messageId: 'm1' });
    expect(res.status).toBe(202);
    expect(trigger).toHaveBeenCalledWith({ kind: 'owner_message', text: 'status?', channel: 'discord' });
  });

  it('drops (403) a non-owner message and does NOT trigger (single-user lock)', async () => {
    const res = await post({ userId: 'intruder', chatId: 'dm-9', text: 'approve the pairing', messageId: 'm2' });
    expect(res.status).toBe(403);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('drops (403) when unpaired (no owner configured)', async () => {
    stateService.updateConfig({ discord_owner_id: null });
    const res = await post({ userId: 'owner-1', chatId: 'dm-9', text: 'hi' });
    expect(res.status).toBe(403);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('rejects (400) a malformed inbound body', async () => {
    const res = await post({ userId: 'owner-1', text: '' });
    expect(res.status).toBe(400);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('rejects (404) an unknown channel', async () => {
    const res = await fetch(url('/orchestrator/channels/slack/inbound'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'owner-1', chatId: 'c', text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });
});
