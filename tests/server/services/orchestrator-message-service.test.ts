import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import { OrchestratorMessageService } from '../../../server/services/orchestrator-message-service';
import type Database from 'better-sqlite3';

let db: Database.Database;
let svc: OrchestratorMessageService;
beforeEach(() => {
  db = makeMigratedDb();
  svc = new OrchestratorMessageService(db);
});
afterEach(() => db.close());

describe('OrchestratorMessageService', () => {
  it('appends a message and returns it with a generated id', () => {
    const m = svc.append({
      role: 'owner',
      channel: 'app',
      content: 'status?',
      tool_calls_json: null,
      trigger_kind: 'owner_message',
    });
    expect(m.id).toBeTruthy();
    expect(m.created_at).toBeGreaterThan(0);
    expect(m.content).toBe('status?');
  });

  it('lists messages in chronological order, newest last', () => {
    svc.append({ role: 'owner', channel: 'app', content: 'first', tool_calls_json: null, trigger_kind: 'owner_message' });
    svc.append({ role: 'orchestrator', channel: 'app', content: 'second', tool_calls_json: null, trigger_kind: null });
    expect(svc.list(50).map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('recent(n) returns the last n in chronological order', () => {
    for (let i = 0; i < 5; i++) {
      svc.append({ role: 'owner', channel: 'app', content: `m${i}`, tool_calls_json: null, trigger_kind: null });
    }
    expect(svc.recent(2).map((m) => m.content)).toEqual(['m3', 'm4']);
  });
});
