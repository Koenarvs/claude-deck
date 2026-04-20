import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createTarGzStream, createMultiSessionTarStream } from '../tar-utils';
import logger from '../logger';

/**
 * Creates trace API routes for downloading session trace files and bundles.
 *
 * Endpoints:
 * - GET /api/sessions/:id/trace/stream  — stream.jsonl for a session
 * - GET /api/sessions/:id/trace/hooks   — hooks.jsonl for a session
 * - GET /api/sessions/:id/trace/stderr  — stderr.log for a session
 * - GET /api/sessions/:id/trace/meta    — meta.json for a session
 * - GET /api/sessions/:id/trace/bundle  — tar.gz of the session's trace dir
 * - GET /api/goals/:id/trace            — tar of all sessions' trace dirs for a goal
 *
 * @param db - The SQLite database connection (for looking up sessions/goals).
 * @param dataDir - The root data directory where traces are stored.
 * @returns An Express Router with trace endpoints mounted.
 */
export function createTraceRouter(db: Database.Database, dataDir: string): Router {
  const router = Router();

  /**
   * Resolves a session's trace directory from the database.
   * Returns null if the session doesn't exist or has no trace_dir.
   */
  function getSessionTraceDir(sessionId: string): string | null {
    const row = db
      .prepare('SELECT trace_dir FROM sessions WHERE id = ?')
      .get(sessionId) as { trace_dir: string | null } | undefined;

    if (!row || !row.trace_dir) return null;
    return row.trace_dir;
  }

  /**
   * Serves a specific file from a session's trace directory.
   * Returns 404 if the session, trace dir, or file doesn't exist.
   */
  function serveTraceFile(
    req: Request,
    res: Response,
    filename: string,
    contentType: string,
  ): void {
    const sessionId = req.params['id'];
    if (!sessionId) {
      res.status(400).json({ error: 'Missing session ID' });
      return;
    }

    const traceDir = getSessionTraceDir(sessionId);
    if (!traceDir) {
      res.status(404).json({ error: 'Session not found or no trace directory' });
      return;
    }

    const filePath = path.join(traceDir, filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: `Trace file not found: ${filename}` });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sessionId}-${filename}"`,
    );

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
    readStream.on('error', (err) => {
      logger.error({ err, sessionId, filename }, 'Error streaming trace file');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error reading trace file' });
      }
    });
  }

  /** GET /api/sessions/:id/trace/stream — raw stream.jsonl */
  router.get('/sessions/:id/trace/stream', (req: Request, res: Response) => {
    serveTraceFile(req, res, 'stream.jsonl', 'application/x-ndjson');
  });

  /** GET /api/sessions/:id/trace/hooks — raw hooks.jsonl */
  router.get('/sessions/:id/trace/hooks', (req: Request, res: Response) => {
    serveTraceFile(req, res, 'hooks.jsonl', 'application/x-ndjson');
  });

  /** GET /api/sessions/:id/trace/stderr — raw stderr.log */
  router.get('/sessions/:id/trace/stderr', (req: Request, res: Response) => {
    serveTraceFile(req, res, 'stderr.log', 'text/plain');
  });

  /** GET /api/sessions/:id/trace/meta — session metadata */
  router.get('/sessions/:id/trace/meta', (req: Request, res: Response) => {
    serveTraceFile(req, res, 'meta.json', 'application/json');
  });

  /**
   * GET /api/sessions/:id/trace/bundle — tar.gz of the session's entire trace directory.
   * The archive contains all trace files under a `<session_id>/` prefix.
   */
  router.get('/sessions/:id/trace/bundle', (req: Request, res: Response) => {
    const sessionId = req.params['id'];
    if (!sessionId) {
      res.status(400).json({ error: 'Missing session ID' });
      return;
    }

    const traceDir = getSessionTraceDir(sessionId);
    if (!traceDir || !fs.existsSync(traceDir)) {
      res.status(404).json({ error: 'Session not found or no trace directory' });
      return;
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${sessionId}-trace.tar.gz"`);

    const tarGzStream = createTarGzStream(traceDir, `${sessionId}/`);
    tarGzStream.pipe(res);
    tarGzStream.on('error', (err) => {
      logger.error({ err, sessionId }, 'Error creating trace bundle');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error creating trace bundle' });
      }
    });
  });

  /**
   * GET /api/goals/:id/trace — tar of all sessions' trace directories for a goal.
   * Each session's files appear under `<session_id>/` prefix in the archive.
   */
  router.get('/goals/:id/trace', (req: Request, res: Response) => {
    const goalId = req.params['id'];
    if (!goalId) {
      res.status(400).json({ error: 'Missing goal ID' });
      return;
    }

    // Verify goal exists
    const goal = db.prepare('SELECT id FROM goals WHERE id = ?').get(goalId) as
      | { id: string }
      | undefined;

    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    // Get all sessions for this goal that have trace directories
    const sessions = db
      .prepare(
        'SELECT id, trace_dir FROM sessions WHERE goal_id = ? AND trace_dir IS NOT NULL ORDER BY started_at',
      )
      .all(goalId) as Array<{ id: string; trace_dir: string }>;

    // Filter to sessions whose trace dirs actually exist on disk
    const sessionDirs = sessions
      .filter((s) => fs.existsSync(s.trace_dir))
      .map((s) => ({ sessionId: s.id, dirPath: s.trace_dir }));

    if (sessionDirs.length === 0) {
      res.status(404).json({ error: 'No trace directories found for this goal' });
      return;
    }

    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${goalId}-traces.tar"`);

    const tarStream = createMultiSessionTarStream(sessionDirs);
    tarStream.pipe(res);
    tarStream.on('error', (err) => {
      logger.error({ err, goalId }, 'Error creating goal trace bundle');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error creating goal trace bundle' });
      }
    });
  });

  return router;
}
