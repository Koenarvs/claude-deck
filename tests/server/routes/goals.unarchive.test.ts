/**
 * Eval tests for DW-32238: Unarchive regression fix — Route layer
 *
 * These tests verify HTTP behavior when restoring archived goals with
 * title collisions. After the fix:
 * - PATCH /goals/:id with status='active' should return 200 with auto-suffixed title
 *   (not 409) when an archived goal collides with an active one.
 * - The 409 response should still work for explicit title renames to taken names.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createGoalService } from '../../../server/services/goal-service';
import { createGoalsRouter } from '../../../server/routes/goals';
import type { GoalService } from '../../../server/services/goal-service';
import type { Goal } from '../../../src/shared/types';

vi.mock('../../../server/ws', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../../server/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let db: Database.Database;
let goalService: GoalService;
let server: http.Server;
let port: number;

function url(path: string): string {
  return `http://127.0.0.1:${port}/api${path}`;
}

async function patchJson(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  goalService = createGoalService(db);

  const app = express();
  app.use(express.json());
  app.use('/api', createGoalsRouter(goalService));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });

  server = http.createServer(app);
  port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
    });
  });
});

afterEach(() => {
  server.close();
  db.close();
});

describe('Goals API — unarchive with auto-suffix', () => {
  it('returns 200 with auto-suffixed title when restoring with collision', async () => {
    // Create and archive
    const original = goalService.create({ title: 'Collider', cwd: '/tmp' });
    goalService.archive(original.id);

    // Create another with the same title
    goalService.create({ title: 'Collider', cwd: '/tmp' });

    // PATCH to restore — should succeed with auto-suffix, not 409
    const res = await patchJson(`/goals/${original.id}`, { status: 'active' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Goal;
    expect(body.status).toBe('active');
    expect(body.title).toBe('Collider (restored)');
  });

  it('returns 200 with incremented suffix when "(restored)" also collides', async () => {
    const original = goalService.create({ title: 'Collider', cwd: '/tmp' });
    goalService.archive(original.id);

    goalService.create({ title: 'Collider', cwd: '/tmp' });
    goalService.create({ title: 'Collider (restored)', cwd: '/tmp' });

    const res = await patchJson(`/goals/${original.id}`, { status: 'active' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Goal;
    expect(body.title).toBe('Collider (restored 2)');
  });

  it('returns 200 with unchanged title when no collision exists', async () => {
    const original = goalService.create({ title: 'No Collision', cwd: '/tmp' });
    goalService.archive(original.id);

    const res = await patchJson(`/goals/${original.id}`, { status: 'active' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Goal;
    expect(body.title).toBe('No Collision');
  });

  it('does not auto-suffix when explicitly renaming to an existing title (non-unarchive)', async () => {
    goalService.create({ title: 'Taken', cwd: '/tmp' });
    const other = goalService.create({ title: 'Other', cwd: '/tmp' });

    // Renaming (not un-archiving) should NOT auto-suffix — it should fail
    const res = await patchJson(`/goals/${other.id}`, { title: 'Taken' });
    // Should not be 200 — auto-suffix only applies during restore
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns correct goal ID after auto-suffixed restore', async () => {
    const original = goalService.create({ title: 'Track ID', cwd: '/tmp' });
    const originalId = original.id;
    goalService.archive(original.id);

    goalService.create({ title: 'Track ID', cwd: '/tmp' });

    const res = await patchJson(`/goals/${originalId}`, { status: 'active' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Goal;
    // Same goal, just renamed
    expect(body.id).toBe(originalId);
    expect(body.title).toBe('Track ID (restored)');
  });

  it('GET /goals/:id returns updated title after auto-suffixed restore', async () => {
    const original = goalService.create({ title: 'Fetch After', cwd: '/tmp' });
    goalService.archive(original.id);

    goalService.create({ title: 'Fetch After', cwd: '/tmp' });

    await patchJson(`/goals/${original.id}`, { status: 'active' });

    // Verify via GET
    const getRes = await fetch(url(`/goals/${original.id}`));
    expect(getRes.status).toBe(200);

    const detail = (await getRes.json()) as { goal: Goal };
    expect(detail.goal.title).toBe('Fetch After (restored)');
    expect(detail.goal.status).toBe('active');
  });
});
