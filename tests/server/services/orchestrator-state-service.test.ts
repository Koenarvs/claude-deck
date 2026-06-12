import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { OrchestratorStateService } from '../../../server/services/orchestrator-state-service';
import type Database from 'better-sqlite3';

let db: Database.Database;
let svc: OrchestratorStateService;
beforeEach(() => {
  db = makeMigratedDb();
  svc = new OrchestratorStateService(db);
});
afterEach(() => db.close());

describe('OrchestratorStateService', () => {
  it('reads the seeded singleton with defaults', () => {
    const state = svc.get();
    expect(state.status).toBe('idle');
    expect(state.config.persona_name).toBe('Hawat');
    expect(state.config.enabled).toBe(false);
  });

  it('setStatus persists and stamps last_wake_at on waking', () => {
    svc.setStatus('waking', 123);
    const state = svc.get();
    expect(state.status).toBe('waking');
    expect(state.last_wake_at).toBe(123);
  });

  it('updateConfig merges, validates, and persists', () => {
    const next = svc.updateConfig({ enabled: true, persona_name: 'Thufir', idle_timeout_ms: 60_000 });
    expect(next.enabled).toBe(true);
    expect(next.persona_name).toBe('Thufir');
    expect(next.idle_timeout_ms).toBe(60_000);
    expect(svc.get().config.model).toBe('haiku'); // untouched field preserved
  });

  it('updateConfig rejects an invalid idle_timeout_ms below the floor', () => {
    expect(() => svc.updateConfig({ idle_timeout_ms: 5 })).toThrow();
  });
});
