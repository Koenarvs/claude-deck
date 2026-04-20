import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { SessionService } from '../../../server/services/session-service';
import { MessageService } from '../../../server/services/message-service';
import { createSessionsRouter } from '../../../server/routes/sessions';
import type { ServerEvent } from '../../../src/shared/events';
import type { Session, Message } from '../../../src/shared/types';

describe('Sessions Routes', () => {
  let db: Database.Database;
  let server: http.Server;
  let port: number;
  let broadcasts: ServerEvent[];
  let broadcastFn: (event: ServerEvent) => void;
  let sessionService: SessionService;
  let messageService: MessageService;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    broadcasts = [];
    broadcastFn = (event: ServerEvent) => {
      broadcasts.push(event);
    };

    sessionService = new SessionService(db, broadcastFn);
    messageService = new MessageService(db, broadcastFn);

    const app = express();
    app.use(express.json());
    const router = createSessionsRouter(sessionService, messageService);
    app.use('/api', router);
    // Express 5 error handler — prevents HTML error responses
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    port = await new Promise<number>((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        }
      });
    });
  });

  afterAll(() => {
    server.close();
    db.close();
  });

  beforeEach(() => {
    broadcasts = [];
  });

  /** Helper to make fetch calls against the test server */
  function api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, init);
  }

  describe('GET /api/sessions', () => {
    beforeAll(() => {
      // Seed sessions for list tests
      sessionService.create({ id: 'list-ext-1', origin: 'external', started_at: 1700000001000 });
      sessionService.create({ id: 'list-ext-2', origin: 'external', started_at: 1700000002000 });
      sessionService.create({ id: 'list-dash-1', origin: 'dashboard', started_at: 1700000003000 });
      sessionService.end('list-ext-1');
    });

    it('returns all sessions as JSON array', async () => {
      const res = await api('/api/sessions');
      const body = (await res.json()) as Session[] & { error?: string };

      if (res.status !== 200) {
        console.error('GET /api/sessions failed:', JSON.stringify(body));
      }
      expect(res.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(3);
    });

    it('filters by origin=external', async () => {
      const res = await api('/api/sessions?origin=external');
      const body = (await res.json()) as Session[];

      expect(res.status).toBe(200);
      expect(body.every((s) => s.origin === 'external')).toBe(true);
    });

    it('filters by origin=dashboard', async () => {
      const res = await api('/api/sessions?origin=dashboard');
      const body = (await res.json()) as Session[];

      expect(res.status).toBe(200);
      expect(body.every((s) => s.origin === 'dashboard')).toBe(true);
    });

    it('filters by active=true', async () => {
      const res = await api('/api/sessions?active=true');
      const body = (await res.json()) as Session[];

      expect(res.status).toBe(200);
      expect(body.every((s) => s.ended_at === null)).toBe(true);
    });

    it('filters by active=false', async () => {
      const res = await api('/api/sessions?active=false');
      const body = (await res.json()) as Session[];

      expect(res.status).toBe(200);
      expect(body.every((s) => s.ended_at !== null)).toBe(true);
    });

    it('respects limit parameter', async () => {
      const res = await api('/api/sessions?limit=1');
      const body = (await res.json()) as Session[];

      expect(res.status).toBe(200);
      expect(body).toHaveLength(1);
    });

    it('respects offset parameter', async () => {
      const allRes = await api('/api/sessions');
      const all = (await allRes.json()) as Session[];

      const offsetRes = await api('/api/sessions?offset=1');
      const offset = (await offsetRes.json()) as Session[];

      expect(offset).toHaveLength(all.length - 1);
    });

    it('rejects invalid origin', async () => {
      const res = await api('/api/sessions?origin=bogus');
      expect(res.status).toBe(400);
    });

    it('rejects non-numeric limit', async () => {
      const res = await api('/api/sessions?limit=abc');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/sessions/:id', () => {
    beforeAll(() => {
      sessionService.create({ id: 'detail-sess', origin: 'external', started_at: 1700000000000, cwd: '/project' });
    });

    it('returns session by ID', async () => {
      const res = await api('/api/sessions/detail-sess');
      const body = (await res.json()) as Session;

      expect(res.status).toBe(200);
      expect(body.id).toBe('detail-sess');
      expect(body.origin).toBe('external');
      expect(body.cwd).toBe('/project');
    });

    it('returns 404 for non-existent session', async () => {
      const res = await api('/api/sessions/nonexistent');
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(404);
      expect(body.error).toBe('Session not found');
    });
  });

  describe('GET /api/sessions/:id/messages', () => {
    beforeAll(() => {
      sessionService.create({ id: 'msg-sess', origin: 'dashboard', started_at: 1700000000000 });

      // Seed messages
      for (let i = 0; i < 5; i++) {
        messageService.add({
          session_id: 'msg-sess',
          role: 'user',
          content: `message-${i}`,
          created_at: 1700000000000 + i * 1000,
        });
      }
    });

    it('returns messages for a session', async () => {
      const res = await api('/api/sessions/msg-sess/messages');
      const body = (await res.json()) as Message[];

      expect(res.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(5);
    });

    it('returns messages ordered by created_at ascending', async () => {
      const res = await api('/api/sessions/msg-sess/messages');
      const body = (await res.json()) as Message[];

      for (let i = 1; i < body.length; i++) {
        expect(body[i].created_at).toBeGreaterThanOrEqual(body[i - 1].created_at);
      }
    });

    it('respects limit parameter', async () => {
      const res = await api('/api/sessions/msg-sess/messages?limit=2');
      const body = (await res.json()) as Message[];

      expect(res.status).toBe(200);
      expect(body).toHaveLength(2);
    });

    it('supports before cursor pagination', async () => {
      // First get all messages
      const allRes = await api('/api/sessions/msg-sess/messages');
      const all = (await allRes.json()) as Message[];
      const cursor = all[2].created_at;

      const res = await api(`/api/sessions/msg-sess/messages?before=${cursor}`);
      const body = (await res.json()) as Message[];

      expect(res.status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body.every((m) => m.created_at < cursor)).toBe(true);
    });

    it('returns 404 for messages of non-existent session', async () => {
      const res = await api('/api/sessions/nonexistent/messages');
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(404);
      expect(body.error).toBe('Session not found');
    });

    it('rejects invalid limit', async () => {
      const res = await api('/api/sessions/msg-sess/messages?limit=-1');
      expect(res.status).toBe(400);
    });
  });

  describe('Session counters via GET after incrementCounters', () => {
    beforeAll(() => {
      sessionService.create({ id: 'counter-sess', origin: 'dashboard', started_at: 1700000000000 });
      for (let i = 0; i < 5; i++) {
        sessionService.incrementCounters('counter-sess', { stream: 2, hook: 1, stderr_bytes: 100 });
      }
    });

    it('returns correct counter values after N increments', async () => {
      const res = await api('/api/sessions/counter-sess');
      const body = (await res.json()) as Session;

      expect(res.status).toBe(200);
      expect(body.stream_event_count).toBe(10);
      expect(body.hook_event_count).toBe(5);
      expect(body.stderr_bytes).toBe(500);
    });
  });
});
