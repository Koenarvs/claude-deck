import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createSystemRouter } from '../../../server/routes/system';
import { createConfigService } from '../../../server/services/config-service';

let server: http.Server | null = null;
afterEach(() => { if (server) { server.close(); server = null; } });

// Stub the live model-list services so route tests are hermetic (no network / no
// reading the dev machine's ~/.codex cache). Default returns null → the catalog
// falls back to the static registry-derived models.
type ModelsStub = {
  getModelOptions: () => Promise<Array<{ value: string; label: string }> | null>;
  cachedValues: () => string[];
};
const nullModels: ModelsStub = { getModelOptions: async () => null, cachedValues: () => [] };
function start(
  claudeModels: ModelsStub = nullModels,
  codexModels: ModelsStub = nullModels,
): Promise<{ port: number; base: string }> {
  const db = new Database(':memory:');
  runMigrations(db);
  const configService = createConfigService(db);
  // antigravityModels stubbed too so route tests never spawn the agy PTY.
  const router = createSystemRouter(undefined, {
    configService,
    claudeModels,
    codexModels,
    antigravityModels: { getModelOptions: async () => null, warm: async () => {}, cachedValues: () => [] },
  });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const srv = http.createServer(app);
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      server = srv;
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      resolve({ port, base: `http://127.0.0.1:${port}` });
    }),
  );
}

describe('GET/PUT /api/config (persisted)', () => {
  it('GET on an empty table returns documented defaults + a claude provider + catalog', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.homeRoute).toBe('/board');
    expect(body.tracePruneDays).toBe(90);
    expect(body.defaultModel).toBe('default');
    expect(body.defaultPermissionMode).toBe('supervised');
    expect(body.providers).toEqual([{ id: 'claude', enabled: true, billingMode: 'seat' }]);
    expect(body.headroom).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:8787',
      launchOnStartup: true,
      command: 'headroom proxy --port 8787',
    });
    const catalog = body.catalog as Array<{ id: string; capabilities: { canApprove: boolean } }>;
    expect(catalog.find((c) => c.id === 'claude')?.capabilities.canApprove).toBe(true);
  });

  it('overlays the live Anthropic model list onto the claude catalog entry', async () => {
    const { base } = await start({
      getModelOptions: async () => [
        { value: 'default', label: 'Default' },
        { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      ],
      cachedValues: () => [],
    });
    const body = (await (await fetch(`${base}/api/config`)).json()) as {
      catalog: Array<{ id: string; models: Array<{ value: string; label: string }> }>;
    };
    const claude = body.catalog.find((c) => c.id === 'claude');
    expect(claude?.models.map((m) => m.value)).toEqual(['default', 'claude-opus-4-8', 'claude-opus-4-7']);
    // Other providers keep their static registry-derived models.
    expect(body.catalog.find((c) => c.id === 'codex')).toBeTruthy();
  });

  it('overlays the live Codex model list onto the codex catalog entry', async () => {
    const { base } = await start(nullModels, {
      getModelOptions: async () => [
        { value: 'gpt-5.5', label: 'GPT-5.5' },
        { value: 'gpt-5.2', label: 'gpt-5.2' },
      ],
      cachedValues: () => [],
    });
    const body = (await (await fetch(`${base}/api/config`)).json()) as {
      catalog: Array<{ id: string; models: Array<{ value: string }> }>;
    };
    const codex = body.catalog.find((c) => c.id === 'codex');
    expect(codex?.models.map((m) => m.value)).toEqual(['gpt-5.5', 'gpt-5.2']);
  });

  it('PUT then GET round-trips the updated values (proves persistence)', async () => {
    const { base } = await start();
    await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultModel: 'opus',
        tracePruneDays: 30,
        headroom: { baseUrl: 'http://localhost:9999', launchOnStartup: false },
      }),
    });
    const body = (await (await fetch(`${base}/api/config`)).json()) as Record<string, unknown>;
    expect(body.defaultModel).toBe('opus');
    expect(body.tracePruneDays).toBe(30); // field-name guard (not traceRetentionDays)
    expect(body.headroom).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:9999',
      launchOnStartup: false,
      command: 'headroom proxy --port 8787',
    });
  });

  it('invokes the config update callback with merged headroom config', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const configService = createConfigService(db);
    const onConfigUpdated = vi.fn();
    const router = createSystemRouter(undefined, {
      configService,
      onConfigUpdated,
      claudeModels: nullModels,
      codexModels: nullModels,
      antigravityModels: { getModelOptions: async () => null, warm: async () => {}, cachedValues: () => [] },
    });
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    const srv = http.createServer(app);
    server = srv;
    const port = await new Promise<number>((resolve) =>
      srv.listen(0, '127.0.0.1', () => {
        const a = srv.address();
        resolve(typeof a === 'object' && a ? a.port : 0);
      }),
    );

    await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headroom: { launchOnStartup: false } }),
    });

    expect(onConfigUpdated).toHaveBeenCalledTimes(1);
    expect(onConfigUpdated.mock.calls[0]?.[0].headroom).toEqual({
      enabled: true,
      baseUrl: 'http://localhost:8787',
      launchOnStartup: false,
      command: 'headroom proxy --port 8787',
    });
  });

  it('invalid PUT (tracePruneDays 0) returns 400 and writes nothing', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tracePruneDays: 0 }),
    });
    expect(res.status).toBe(400);
    const after = (await (await fetch(`${base}/api/config`)).json()) as Record<string, unknown>;
    expect(after.tracePruneDays).toBe(90); // unchanged
  });

  it('PUT clearing providers still returns an enabled claude record', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers: [] }),
    });
    const body = (await res.json()) as { providers: Array<{ id: string; enabled: boolean }> };
    expect(body.providers.find((p) => p.id === 'claude')?.enabled).toBe(true);
  });
});
