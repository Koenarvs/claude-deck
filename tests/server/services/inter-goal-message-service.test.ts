import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { broadcast } from '../../../server/ws';
import {
  createInterGoalMessageService,
  InterGoalMessageNotFoundError,
  type InterGoalMessageService,
} from '../../../server/services/inter-goal-message-service';

const broadcastMock = vi.mocked(broadcast);

function seedGoal(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO goals (id, title, cwd, status, permission_mode, kanban_order, created_at, updated_at)
     VALUES (?, ?, '/repo', 'active', 'supervised', 1.0, 1700000000000, 1700000000000)`,
  ).run(id, `Goal ${id}`);
}

describe('InterGoalMessageService', () => {
  let db: Database.Database;
  let service: InterGoalMessageService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    seedGoal(db, 'goal-a');
    seedGoal(db, 'goal-b');
    seedGoal(db, 'goal-c');

    service = createInterGoalMessageService(db);
    broadcastMock.mockClear();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe('sendInstruction', () => {
    it('creates a pending message with default type "instruction" and returns it', () => {
      const before = Date.now();
      const msg = service.sendInstruction('goal-a', 'goal-b', 'do the thing');
      const after = Date.now();

      expect(msg.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(msg.from_goal_id).toBe('goal-a');
      expect(msg.to_goal_id).toBe('goal-b');
      expect(msg.content).toBe('do the thing');
      expect(msg.message_type).toBe('instruction');
      expect(msg.status).toBe('pending');
      expect(msg.created_at).toBeGreaterThanOrEqual(before);
      expect(msg.created_at).toBeLessThanOrEqual(after);
      expect(msg.delivered_at).toBeNull();
      expect(msg.acknowledged_at).toBeNull();
    });

    it('broadcasts a goal:instruction WS event with the created message', () => {
      const msg = service.sendInstruction('goal-a', 'goal-b', 'hello');
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock).toHaveBeenCalledWith({ type: 'goal:instruction', message: msg });
    });

    it('supports non-default message types', () => {
      const msg = service.sendInstruction('goal-b', 'goal-a', 'done', 'result');
      expect(msg.message_type).toBe('result');
    });

    it('rejects a message_type outside the CHECK constraint', () => {
      expect(() =>
        service.sendInstruction(
          'goal-a',
          'goal-b',
          'x',
          'bogus' as unknown as Parameters<typeof service.sendInstruction>[3],
        ),
      ).toThrow();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it('rejects an unknown to_goal_id (FK constraint) without broadcasting', () => {
      expect(() => service.sendInstruction('goal-a', 'no-such-goal', 'x')).toThrow();
      expect(broadcastMock).not.toHaveBeenCalled();
    });

    it('rejects an unknown from_goal_id (FK constraint)', () => {
      expect(() => service.sendInstruction('no-such-goal', 'goal-b', 'x')).toThrow();
    });
  });

  describe('get', () => {
    it('returns the message by id', () => {
      const created = service.sendInstruction('goal-a', 'goal-b', 'hi');
      expect(service.get(created.id)).toEqual(created);
    });

    it('returns null for an unknown id', () => {
      expect(service.get('does-not-exist')).toBeNull();
    });
  });

  describe('getInstructions', () => {
    it('returns an empty array for a goal with no messages', () => {
      expect(service.getInstructions('goal-c')).toEqual([]);
    });

    it('returns pending and delivered messages ordered by created_at ASC', () => {
      // Control created_at ordering via Date.now
      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValue(1000);
      const m1 = service.sendInstruction('goal-a', 'goal-b', 'first');
      nowSpy.mockReturnValue(3000);
      const m3 = service.sendInstruction('goal-a', 'goal-b', 'third');
      nowSpy.mockReturnValue(2000);
      const m2 = service.sendInstruction('goal-c', 'goal-b', 'second');
      nowSpy.mockRestore();

      service.markDelivered(m2.id);

      const list = service.getInstructions('goal-b');
      expect(list.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);
      expect(list.map((m) => m.status)).toEqual(['pending', 'delivered', 'pending']);
    });

    it('excludes acknowledged messages', () => {
      const m1 = service.sendInstruction('goal-a', 'goal-b', 'one');
      const m2 = service.sendInstruction('goal-a', 'goal-b', 'two');
      service.acknowledgeInstruction(m1.id);

      const list = service.getInstructions('goal-b');
      expect(list.map((m) => m.id)).toEqual([m2.id]);
    });

    it('does not return messages addressed to other goals', () => {
      service.sendInstruction('goal-a', 'goal-b', 'for b');
      expect(service.getInstructions('goal-a')).toEqual([]);
    });
  });

  describe('markDelivered', () => {
    it('transitions pending -> delivered and stamps delivered_at', () => {
      const created = service.sendInstruction('goal-a', 'goal-b', 'deliver me');
      const before = Date.now();
      const updated = service.markDelivered(created.id);

      expect(updated.status).toBe('delivered');
      expect(updated.delivered_at).not.toBeNull();
      expect(updated.delivered_at!).toBeGreaterThanOrEqual(before);
      expect(updated.acknowledged_at).toBeNull();
      // persisted
      expect(service.get(created.id)?.status).toBe('delivered');
    });

    it('throws InterGoalMessageNotFoundError for an unknown id', () => {
      expect(() => service.markDelivered('nope')).toThrow(InterGoalMessageNotFoundError);
      try {
        service.markDelivered('nope');
      } catch (err) {
        expect((err as InterGoalMessageNotFoundError).messageId).toBe('nope');
        expect((err as Error).name).toBe('InterGoalMessageNotFoundError');
      }
    });

    it('is idempotent-ish: delivering twice keeps status delivered and updates delivered_at', () => {
      const created = service.sendInstruction('goal-a', 'goal-b', 'x');
      service.markDelivered(created.id);
      const again = service.markDelivered(created.id);
      expect(again.status).toBe('delivered');
    });

    it('markDelivered on an acknowledged message is a no-op (acknowledged is terminal)', () => {
      const created = service.sendInstruction('goal-a', 'goal-b', 'x');
      service.acknowledgeInstruction(created.id);
      const result = service.markDelivered(created.id);
      expect(result.status).toBe('acknowledged');
      // The message must NOT re-appear in the pending/delivered queue
      expect(service.getInstructions('goal-b').map((m) => m.id)).not.toContain(created.id);
      expect(service.get(created.id)?.status).toBe('acknowledged');
    });
  });

  describe('acknowledgeInstruction', () => {
    it('transitions to acknowledged and stamps acknowledged_at', () => {
      const created = service.sendInstruction('goal-a', 'goal-b', 'ack me');
      const before = Date.now();
      const updated = service.acknowledgeInstruction(created.id);

      expect(updated.status).toBe('acknowledged');
      expect(updated.acknowledged_at).not.toBeNull();
      expect(updated.acknowledged_at!).toBeGreaterThanOrEqual(before);
      expect(service.get(created.id)?.status).toBe('acknowledged');
    });

    it('preserves delivered_at when acknowledging a delivered message', () => {
      const created = service.sendInstruction('goal-a', 'goal-b', 'x');
      const delivered = service.markDelivered(created.id);
      const acked = service.acknowledgeInstruction(created.id);
      expect(acked.delivered_at).toBe(delivered.delivered_at);
    });

    it('throws InterGoalMessageNotFoundError for an unknown id', () => {
      expect(() => service.acknowledgeInstruction('missing')).toThrow(
        InterGoalMessageNotFoundError,
      );
    });
  });
});
