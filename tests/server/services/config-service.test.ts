import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createConfigService } from '../../../server/services/config-service';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE app_config (id INTEGER PRIMARY KEY CHECK (id = 1), config_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  return db;
}

describe('config-service', () => {
  let db: Database.Database;
  let svc: ReturnType<typeof createConfigService>;
  beforeEach(() => {
    db = freshDb();
    svc = createConfigService(db);
  });

  it('seeds defaults when no row exists', () => {
    const c = svc.getPersisted();
    expect(c.defaultModel).toBe('default');
    expect(c.providers).toEqual([{ id: 'claude', enabled: true, billingMode: 'seat' }]);
    expect(c.tracePruneDays).toBe(90);
  });

  it('persists and merges partial updates', () => {
    svc.updatePersisted({ defaultModel: 'opus' });
    expect(svc.getPersisted().defaultModel).toBe('opus');
    expect(svc.getPersisted().homeRoute).toBe('/board'); // unchanged
  });

  it('always keeps a claude record enabled', () => {
    svc.updatePersisted({ providers: [] });
    expect(svc.getPersisted().providers.find((p) => p.id === 'claude')?.enabled).toBe(true);

    svc.updatePersisted({
      providers: [
        { id: 'antigravity', enabled: true, billingMode: 'seat' },
        { id: 'claude', enabled: false, billingMode: 'seat' },
      ],
    });
    const c = svc.getPersisted();
    expect(c.providers.find((p) => p.id === 'claude')?.enabled).toBe(true); // forced on
    expect(c.providers.some((p) => p.id === 'antigravity')).toBe(true);
  });

  it('seeds headroom defaults (enabled, balanced, all features on)', () => {
    const h = svc.getPersisted().headroom;
    expect(h.enabled).toBe(true);
    expect(h.compressionDegree).toBe('balanced');
    expect(h.interceptToolResults).toBe(true);
    expect(h.memory).toBe(true);
    expect(h.vertexApiUrl).toBe('https://aiplatform.googleapis.com');
    expect(h.command).toBeUndefined();
  });

  it('shallow-merges partial headroom updates without dropping siblings', () => {
    svc.updatePersisted({ headroom: { enabled: true } as never });
    const h = svc.getPersisted().headroom;
    expect(h.enabled).toBe(true);
    expect(h.compressionDegree).toBe('balanced'); // preserved
    expect(h.vertexApiUrl).toBe('https://aiplatform.googleapis.com'); // preserved
  });

  it('normalizes a legacy/empty command override back to undefined', () => {
    svc.updatePersisted({ headroom: { command: 'headroom proxy --port 8787' } as never });
    expect(svc.getPersisted().headroom.command).toBeUndefined();
    svc.updatePersisted({ headroom: { command: '   ' } as never });
    expect(svc.getPersisted().headroom.command).toBeUndefined();
    svc.updatePersisted({ headroom: { command: 'headroom proxy --custom' } as never });
    expect(svc.getPersisted().headroom.command).toBe('headroom proxy --custom');
  });

  it('round-trips provider billing config through a fresh service on the same db', () => {
    svc.updatePersisted({
      tracePruneDays: 30,
      providers: [{ id: 'claude', enabled: true, billingMode: 'metered', seatPriceUsdMonthly: 200 }],
    });
    const svc2 = createConfigService(db);
    expect(svc2.getPersisted().tracePruneDays).toBe(30);
    const claude = svc2.getPersisted().providers.find((p) => p.id === 'claude');
    expect(claude?.billingMode).toBe('metered');
    expect(claude?.seatPriceUsdMonthly).toBe(200);
  });
});
