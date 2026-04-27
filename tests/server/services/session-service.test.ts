import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { SessionService } from '../../../server/services/session-service';
import { MessageService as MessageServiceImpl } from '../../../server/services/message-service';
import type { ServerEvent } from '../../../src/shared/events';

describe('SessionService', () => {
  let db: Database.Database;
  let broadcasts: ServerEvent[];
  let broadcastFn: (event: ServerEvent) => void;
  let service: SessionService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    broadcasts = [];
    broadcastFn = (event: ServerEvent) => {
      broadcasts.push(event);
    };
    service = new SessionService(db, broadcastFn);
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('creates a session and returns it with all default fields', () => {
      const session = service.create({
        id: 'sess-1',
        origin: 'external',
        started_at: 1700000000000,
      });

      expect(session.id).toBe('sess-1');
      expect(session.origin).toBe('external');
      expect(session.goal_id).toBeNull();
      expect(session.cwd).toBeNull();
      expect(session.model).toBeNull();
      expect(session.trace_dir).toBeNull();
      expect(session.stream_event_count).toBe(0);
      expect(session.hook_event_count).toBe(0);
      expect(session.stderr_bytes).toBe(0);
      expect(session.started_at).toBe(1700000000000);
      expect(session.ended_at).toBeNull();
    });

    it('creates a session with all optional fields', () => {
      const session = service.create({
        id: 'sess-2',
        origin: 'dashboard',
        started_at: 1700000000000,
        goal_id: null,
        cwd: '/tmp/project',
        model: 'opus',
      });

      expect(session.cwd).toBe('/tmp/project');
      expect(session.model).toBe('opus');
    });

    it('broadcasts session:observed for external sessions', () => {
      service.create({
        id: 'sess-ext',
        origin: 'external',
        started_at: 1700000000000,
      });

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].type).toBe('session:observed');
      const event = broadcasts[0] as Extract<ServerEvent, { type: 'session:observed' }>;
      expect(event.session.id).toBe('sess-ext');
      expect(event.session.origin).toBe('external');
    });

    it('does NOT broadcast session:observed for dashboard sessions', () => {
      service.create({
        id: 'sess-dash',
        origin: 'dashboard',
        started_at: 1700000000000,
      });

      expect(broadcasts).toHaveLength(0);
    });

    it('handles duplicate session_id idempotently (INSERT OR IGNORE)', () => {
      const first = service.create({
        id: 'sess-dup',
        origin: 'external',
        started_at: 1700000000000,
      });

      const second = service.create({
        id: 'sess-dup',
        origin: 'external',
        started_at: 1700000099999,
      });

      // Both return the same row
      expect(first.id).toBe(second.id);
      expect(first.started_at).toBe(second.started_at);

      // Only one broadcast (from the first insert)
      expect(broadcasts.filter((b) => b.type === 'session:observed')).toHaveLength(1);

      // Only one row in the database
      const count = db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE id = ?').get('sess-dup') as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  describe('get', () => {
    it('returns session by ID', () => {
      service.create({ id: 'sess-g', origin: 'external', started_at: 1700000000000 });
      const session = service.get('sess-g');

      expect(session).not.toBeNull();
      expect(session!.id).toBe('sess-g');
    });

    it('returns null for non-existent session', () => {
      expect(service.get('nonexistent')).toBeNull();
    });
  });

  describe('list', () => {
    beforeEach(() => {
      service.create({ id: 'sess-ext-1', origin: 'external', started_at: 1700000001000 });
      service.create({ id: 'sess-ext-2', origin: 'external', started_at: 1700000002000 });
      service.create({ id: 'sess-dash-1', origin: 'dashboard', started_at: 1700000003000 });
      // End one external session
      service.end('sess-ext-1');
      broadcasts = []; // Clear setup broadcasts
    });

    it('lists all sessions ordered by started_at DESC', () => {
      const sessions = service.list();
      expect(sessions).toHaveLength(3);
      expect(sessions[0].id).toBe('sess-dash-1');
      expect(sessions[1].id).toBe('sess-ext-2');
      expect(sessions[2].id).toBe('sess-ext-1');
    });

    it('filters by origin=external', () => {
      const sessions = service.list({ origin: 'external' });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.origin === 'external')).toBe(true);
    });

    it('filters by origin=dashboard', () => {
      const sessions = service.list({ origin: 'dashboard' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].origin).toBe('dashboard');
    });

    it('filters active=true (ended_at IS NULL)', () => {
      const sessions = service.list({ active: true });
      expect(sessions).toHaveLength(2); // sess-ext-2 and sess-dash-1
      expect(sessions.every((s) => s.ended_at === null)).toBe(true);
    });

    it('filters active=false (ended_at IS NOT NULL)', () => {
      const sessions = service.list({ active: false });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('sess-ext-1');
      expect(sessions[0].ended_at).not.toBeNull();
    });

    it('combines origin and active filters', () => {
      const sessions = service.list({ origin: 'external', active: true });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('sess-ext-2');
    });

    it('respects limit', () => {
      const sessions = service.list({ limit: 2 });
      expect(sessions).toHaveLength(2);
    });

    it('respects offset', () => {
      const sessions = service.list({ offset: 1 });
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe('sess-ext-2');
    });

    it('handles limit + offset pagination', () => {
      const page1 = service.list({ limit: 1, offset: 0 });
      const page2 = service.list({ limit: 1, offset: 1 });
      const page3 = service.list({ limit: 1, offset: 2 });

      expect(page1).toHaveLength(1);
      expect(page2).toHaveLength(1);
      expect(page3).toHaveLength(1);
      expect(page1[0].id).not.toBe(page2[0].id);
      expect(page2[0].id).not.toBe(page3[0].id);
    });

    it('returns empty array when no sessions match', () => {
      const sessions = service.list({ origin: 'dashboard', active: false });
      expect(sessions).toHaveLength(0);
    });
  });

  describe('end', () => {
    it('sets ended_at and broadcasts session:ended', () => {
      service.create({ id: 'sess-end', origin: 'external', started_at: 1700000000000 });
      broadcasts = [];

      service.end('sess-end');

      const session = service.get('sess-end');
      expect(session!.ended_at).not.toBeNull();
      expect(session!.ended_at).toBeGreaterThan(0);

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].type).toBe('session:ended');
      const event = broadcasts[0] as Extract<ServerEvent, { type: 'session:ended' }>;
      expect(event.id).toBe('sess-end');
    });

    it('end sets ended_at without additional metadata', () => {
      service.create({ id: 'sess-meta', origin: 'dashboard', started_at: 1700000000000 });
      broadcasts = [];

      service.end('sess-meta');

      const session = service.get('sess-meta');
      expect(session!.ended_at).not.toBeNull();
      expect(session!.ended_at).toBeGreaterThan(0);
    });
  });

  describe('updateTraceDir', () => {
    it('updates the trace_dir field', () => {
      service.create({ id: 'sess-trace', origin: 'dashboard', started_at: 1700000000000 });

      service.updateTraceDir('sess-trace', '/data/traces/sess-trace');

      const session = service.get('sess-trace');
      expect(session!.trace_dir).toBe('/data/traces/sess-trace');
    });
  });

  describe('incrementCounters', () => {
    beforeEach(() => {
      service.create({ id: 'sess-cnt', origin: 'dashboard', started_at: 1700000000000 });
      broadcasts = [];
    });

    it('increments stream_event_count atomically', () => {
      service.incrementCounters('sess-cnt', { stream: 5 });
      service.incrementCounters('sess-cnt', { stream: 3 });

      const session = service.get('sess-cnt');
      expect(session!.stream_event_count).toBe(8);
    });

    it('increments hook_event_count atomically', () => {
      service.incrementCounters('sess-cnt', { hook: 2 });
      service.incrementCounters('sess-cnt', { hook: 4 });

      const session = service.get('sess-cnt');
      expect(session!.hook_event_count).toBe(6);
    });

    it('increments stderr_bytes atomically', () => {
      service.incrementCounters('sess-cnt', { stderr_bytes: 1024 });
      service.incrementCounters('sess-cnt', { stderr_bytes: 512 });

      const session = service.get('sess-cnt');
      expect(session!.stderr_bytes).toBe(1536);
    });

    it('increments multiple counters at once', () => {
      service.incrementCounters('sess-cnt', { stream: 10, hook: 3, stderr_bytes: 256 });

      const session = service.get('sess-cnt');
      expect(session!.stream_event_count).toBe(10);
      expect(session!.hook_event_count).toBe(3);
      expect(session!.stderr_bytes).toBe(256);
    });

    it('no-ops when no counters provided', () => {
      service.incrementCounters('sess-cnt', {});

      const session = service.get('sess-cnt');
      expect(session!.stream_event_count).toBe(0);
      expect(session!.hook_event_count).toBe(0);
      expect(session!.stderr_bytes).toBe(0);
    });

    it('no-ops for zero-value counters', () => {
      service.incrementCounters('sess-cnt', { stream: 0, hook: 0, stderr_bytes: 0 });

      const session = service.get('sess-cnt');
      expect(session!.stream_event_count).toBe(0);
    });

    it('produces correct totals after N increment calls', () => {
      for (let i = 0; i < 10; i++) {
        service.incrementCounters('sess-cnt', { stream: 1, hook: 1 });
      }

      const session = service.get('sess-cnt');
      expect(session!.stream_event_count).toBe(10);
      expect(session!.hook_event_count).toBe(10);
    });
  });

  describe('linkGoal', () => {
    it('updates sessions.goal_id', () => {
      // Create goal first
      db.prepare(`
        INSERT INTO goals (id, title, cwd, status, priority, permission_mode, kanban_order, created_at, updated_at)
        VALUES ('goal-1', 'Test Goal', '/tmp', 'active', 0, 'supervised', 1.0, 1700000000000, 1700000000000)
      `).run();

      service.create({ id: 'sess-adopt', origin: 'external', started_at: 1700000000000 });

      service.linkGoal('sess-adopt', 'goal-1');

      const session = service.get('sess-adopt');
      expect(session!.goal_id).toBe('goal-1');
    });

    it('subsequent messages from linked session include goal_id in broadcast', () => {
      // Create goal and session
      db.prepare(`
        INSERT INTO goals (id, title, cwd, status, priority, permission_mode, kanban_order, created_at, updated_at)
        VALUES ('goal-link', 'Link Goal', '/tmp', 'active', 0, 'supervised', 1.0, 1700000000000, 1700000000000)
      `).run();
      service.create({ id: 'sess-link', origin: 'external', started_at: 1700000000000 });

      // Link session to goal
      service.linkGoal('sess-link', 'goal-link');

      // Create a message service and add a message
      const msgService = new MessageServiceImpl(db, broadcastFn);
      broadcasts = [];

      msgService.add({
        session_id: 'sess-link',
        role: 'assistant',
        content: 'post-link message',
      });

      expect(broadcasts).toHaveLength(1);
      const event = broadcasts[0] as Extract<ServerEvent, { type: 'message:added' }>;
      expect(event.goal_id).toBe('goal-link');
    });
  });
});
