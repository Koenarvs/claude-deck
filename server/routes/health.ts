import { Router } from 'express';

const router = Router();

/** GET /health — returns server health status and uptime. */
router.get('/health', (req, res) => {
  const result: Record<string, unknown> = { ok: true, uptime: process.uptime() };

  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (db) {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage'").get();
      if (hasTable) {
        const row = db.prepare('SELECT COUNT(*) as cnt, MAX(ingested_at) as lastAt FROM session_usage').get() as { cnt: number; lastAt: number | null };
        result.ingestion = { sessionsIngested: row.cnt, lastIngestionAt: row.lastAt ?? null };
      }
    }
  } catch { /* ignore */ }

  res.json(result);
});

export default router;
