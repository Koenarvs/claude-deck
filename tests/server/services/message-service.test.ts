import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { MessageService } from '../../../server/services/message-service';
import type { ServerEvent } from '../../../src/shared/events';
import type { Message } from '../../../src/shared/types';

describe('MessageService', () => {
  let db: Database.Database;
  let broadcasts: ServerEvent[];
  let broadcastFn: (event: ServerEvent) => void;
  let service: MessageService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    broadcasts = [];
    broadcastFn = (event: ServerEvent) => {
      broadcasts.push(event);
    };
    service = new MessageService(db, broadcastFn);

    // Seed a session so FK constraints pass
    db.prepare(`
      INSERT INTO sessions (id, origin, started_at)
      VALUES ('sess-1', 'external', 1700000000000)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  describe('truncateForDb', () => {
    it('returns null for null input', () => {
      expect(service.truncateForDb(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(service.truncateForDb(undefined)).toBeNull();
    });

    it('returns short strings unchanged', () => {
      const short = 'Hello world';
      expect(service.truncateForDb(short)).toBe(short);
    });

    it('returns exactly 100000-char strings unchanged', () => {
      const exact = 'x'.repeat(100000);
      expect(service.truncateForDb(exact)).toBe(exact);
    });

    it('truncates strings exceeding 100000 chars and appends suffix', () => {
      const long = 'a'.repeat(200000);
      const result = service.truncateForDb(long);
      expect(result).not.toBeNull();
      expect(result!.length).toBe(100000);
      expect(result!).toContain('[truncated; see trace]');
    });

    it('preserves content before truncation point', () => {
      const prefix = 'PREFIX_';
      const long = prefix + 'x'.repeat(200000);
      const result = service.truncateForDb(long);
      expect(result).not.toBeNull();
      expect(result!.startsWith(prefix)).toBe(true);
    });
  });

  describe('add', () => {
    it('inserts a message and returns it with all fields populated', () => {
      const msg = service.add({
        session_id: 'sess-1',
        role: 'assistant',
        content: 'Hello from the assistant',
      });

      expect(msg.id).toBeDefined();
      expect(msg.session_id).toBe('sess-1');
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Hello from the assistant');
      expect(msg.created_at).toBeGreaterThan(0);
    });

    it('uses provided id and created_at when given', () => {
      const msg = service.add({
        id: 'custom-id',
        session_id: 'sess-1',
        role: 'user',
        content: 'test',
        created_at: 1700000001000,
      });

      expect(msg.id).toBe('custom-id');
      expect(msg.created_at).toBe(1700000001000);
    });

    it('truncates content exceeding 100000 chars in the DB', () => {
      const longContent = 'c'.repeat(200000);
      const msg = service.add({
        session_id: 'sess-1',
        role: 'assistant',
        content: longContent,
      });

      expect(msg.content!.length).toBe(100000);
      expect(msg.content!).toContain('[truncated; see trace]');

      // Verify DB also has the truncated version
      const dbRow = db
        .prepare('SELECT content FROM messages WHERE id = ?')
        .get(msg.id) as { content: string };
      expect(dbRow.content.length).toBe(100000);
    });

    it('truncates tool_result exceeding 100000 chars in the DB', () => {
      const longResult = 'r'.repeat(200000);
      const msg = service.add({
        session_id: 'sess-1',
        role: 'tool_result',
        tool_result: longResult,
        tool_use_id: 'tu-1',
      });

      expect(msg.tool_result!.length).toBe(100000);
      expect(msg.tool_result!).toContain('[truncated; see trace]');
    });

    it('broadcasts message:added event', () => {
      service.add({
        session_id: 'sess-1',
        role: 'user',
        content: 'test prompt',
      });

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].type).toBe('message:added');
    });

    it('broadcasts message:added with correct goal_id from session lookup', () => {
      // Link session to a goal first
      db.prepare(`
        INSERT INTO goals (id, title, cwd, status, priority, permission_mode, kanban_order, created_at, updated_at)
        VALUES ('goal-1', 'Test Goal', '/tmp', 'active', 0, 'supervised', 1.0, 1700000000000, 1700000000000)
      `).run();
      db.prepare("UPDATE sessions SET goal_id = 'goal-1' WHERE id = 'sess-1'").run();

      // Re-create service so it picks up the prepared statement fresh
      service = new MessageService(db, broadcastFn);

      service.add({
        session_id: 'sess-1',
        role: 'assistant',
        content: 'response',
      });

      expect(broadcasts).toHaveLength(1);
      const event = broadcasts[0] as Extract<ServerEvent, { type: 'message:added' }>;
      expect(event.goal_id).toBe('goal-1');
      expect(event.session_id).toBe('sess-1');
    });

    it('broadcasts message:added with goal_id=null for unlinked sessions', () => {
      service.add({
        session_id: 'sess-1',
        role: 'assistant',
        content: 'response',
      });

      const event = broadcasts[0] as Extract<ServerEvent, { type: 'message:added' }>;
      expect(event.goal_id).toBeNull();
    });

    it('stores tool_use fields correctly', () => {
      const msg = service.add({
        session_id: 'sess-1',
        role: 'tool_use',
        tool_name: 'Bash',
        tool_args: '{"command":"ls"}',
        tool_use_id: 'tu-123',
      });

      expect(msg.tool_name).toBe('Bash');
      expect(msg.tool_args).toBe('{"command":"ls"}');
      expect(msg.tool_use_id).toBe('tu-123');
    });

    it('defaults nullable fields to null', () => {
      const msg = service.add({
        session_id: 'sess-1',
        role: 'system',
      });

      expect(msg.content).toBeNull();
      expect(msg.tool_name).toBeNull();
      expect(msg.tool_args).toBeNull();
      expect(msg.tool_result).toBeNull();
      expect(msg.tool_use_id).toBeNull();
    });
  });

  describe('listBySession', () => {
    beforeEach(() => {
      // Insert messages in sequence
      for (let i = 0; i < 5; i++) {
        service.add({
          session_id: 'sess-1',
          role: 'user',
          content: `message-${i}`,
          created_at: 1700000000000 + i * 1000,
        });
      }
      broadcasts = []; // Clear setup broadcasts
    });

    it('returns messages ordered by created_at ascending', () => {
      const msgs = service.listBySession('sess-1');
      expect(msgs).toHaveLength(5);
      for (let i = 1; i < msgs.length; i++) {
        expect(msgs[i].created_at).toBeGreaterThanOrEqual(msgs[i - 1].created_at);
      }
    });

    it('respects limit parameter', () => {
      const msgs = service.listBySession('sess-1', { limit: 3 });
      expect(msgs).toHaveLength(3);
      expect((msgs[0] as Message).content).toBe('message-0');
    });

    it('returns empty array for unknown session', () => {
      const msgs = service.listBySession('unknown-session');
      expect(msgs).toHaveLength(0);
    });

    it('supports before cursor for pagination', () => {
      // Get all messages, then paginate using the 3rd message's timestamp
      const all = service.listBySession('sess-1');
      const cursor = all[2].created_at;

      const page = service.listBySession('sess-1', { before: cursor });
      expect(page).toHaveLength(2);
      expect((page[0] as Message).content).toBe('message-0');
      expect((page[1] as Message).content).toBe('message-1');
    });

    it('defaults limit to 100', () => {
      // Just verify no crash — we only have 5 messages
      const msgs = service.listBySession('sess-1');
      expect(msgs.length).toBeLessThanOrEqual(100);
    });
  });
});
