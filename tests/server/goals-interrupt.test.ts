import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/db/migrate';
import { createGoalService } from '../../server/services/goal-service';
import { createGoalsRouter } from '../../server/routes/goals';
import { processRegistry, type Killable } from '../../server/process-registry';

function start(db: Database.Database) {
  const svc = createGoalService(db);
  const app = express();
  app.use(express.json());
  app.use('/api', createGoalsRouter(svc));
  const srv = http.createServer(app);
  const portP = new Promise<number>((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }),
  );
  return { svc, srv, portP };
}

describe('POST /goals/:id/interrupt', () => {
  let db: Database.Database;
  const registered: string[] = [];
  beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys=ON'); runMigrations(db); });
  afterEach(() => { for (const id of registered) processRegistry.remove(id); registered.length = 0; db.close(); });

  it('404 when goal missing', async () => {
    const { srv, portP } = start(db);
    const port = await portP;
    const res = await fetch(`http://127.0.0.1:${port}/api/goals/nope/interrupt`, { method: 'POST' });
    expect(res.status).toBe(404);
    srv.close();
  });

  it('calls runner.interrupt() and returns killed:true when a runner is live', async () => {
    const { svc, srv, portP } = start(db);
    const port = await portP;
    const g = svc.create({ title: 'g', cwd: '/x', model: 'default', permission_mode: 'supervised' });
    svc.update(g.id, { status: 'active' }); // realistic precondition for interrupt
    const interrupt = vi.fn().mockResolvedValue(undefined);
    processRegistry.set(g.id, { interrupt } as unknown as Killable);
    registered.push(g.id);
    const res = await fetch(`http://127.0.0.1:${port}/api/goals/${g.id}/interrupt`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ killed: true });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(svc.get(g.id)!.status).toBe('waiting');
    srv.close();
  });

  it('returns killed:false when no runner is registered', async () => {
    const { svc, srv, portP } = start(db);
    const port = await portP;
    const g = svc.create({ title: 'g2', cwd: '/x', model: 'default', permission_mode: 'supervised' });
    const res = await fetch(`http://127.0.0.1:${port}/api/goals/${g.id}/interrupt`, { method: 'POST' });
    expect(await res.json()).toEqual({ killed: false });
    srv.close();
  });
});
