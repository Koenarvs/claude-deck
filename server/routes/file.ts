import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { pathWithinRoots } from '../security/path-allow';
import logger from '../logger';

/** PUT /api/file body. `content` is capped at ~1 MB (chars). */
const PutFileBodySchema = z.object({
  path: z.string().min(1),
  content: z.string().max(1_000_000, 'content exceeds 1 MB limit'),
  baseModifiedMs: z.number().optional(),
});

/**
 * The write allowlist: every registered project root (5A — the formal "document
 * roots") + every persisted skill directory + every goal's cwd. "You can edit
 * what the app is configured to read."
 */
export function editableRoots(db: Database.Database): string[] {
  const roots = new Set<string>();
  try {
    const rows = db.prepare('SELECT root_path FROM projects').all() as { root_path: string }[];
    for (const r of rows) if (r.root_path) roots.add(r.root_path);
  } catch {
    /* projects table absent (pre-5A DBs) */
  }
  try {
    const rows = db.prepare('SELECT path FROM skill_directories').all() as { path: string }[];
    for (const r of rows) if (r.path) roots.add(r.path);
  } catch {
    /* table absent in some minimal DBs */
  }
  try {
    const rows = db
      .prepare('SELECT DISTINCT cwd FROM goals WHERE cwd IS NOT NULL')
      .all() as { cwd: string }[];
    for (const r of rows) if (r.cwd) roots.add(r.cwd);
  } catch {
    /* table absent */
  }
  return [...roots];
}

type WithDb = { locals: { db: Database.Database } };

/**
 * Guarded generic markdown/text write endpoint (design §7). Edit-only — never
 * creates/deletes/renames. Single-user posture: guards are correctness/safety
 * (stop a `..` or textarea typo writing outside configured roots), not a
 * multi-user wall.
 */
export function createFileRouter(): Router {
  const router = Router();

  router.put('/file', (req: Request, res: Response) => {
    const db = (req.app as unknown as WithDb).locals?.db;
    if (!db) {
      res.status(500).json({ error: 'database unavailable' });
      return;
    }

    const parsed = PutFileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }
    const { path: filePath, content, baseModifiedMs } = parsed.data;

    // Type cap: only markdown/plain text.
    if (!/\.(md|txt)$/i.test(filePath)) {
      res.status(400).json({ error: 'Only .md and .txt files can be written' });
      return;
    }

    // Containment: realpath must resolve under an editable root (also rejects
    // traversal + symlink escape, since pathWithinRoots realpaths both sides).
    const roots = editableRoots(db);
    if (roots.length === 0 || !pathWithinRoots(filePath, roots)) {
      logger.warn({ filePath }, 'PUT /file rejected: outside editable document roots');
      res.status(403).json({ error: 'Path is outside the editable document roots' });
      return;
    }

    // Edit-only: must already exist and be a regular file.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.status(404).json({ error: 'File not found (edit-only — cannot create)' });
      return;
    }
    if (!stat.isFile()) {
      res.status(400).json({ error: 'Target is not a regular file' });
      return;
    }

    // Optimistic concurrency: reject if disk changed since the client loaded it.
    if (baseModifiedMs !== undefined && Math.floor(stat.mtimeMs) !== Math.floor(baseModifiedMs)) {
      res.status(409).json({
        error: 'File changed on disk since it was loaded — reload before saving',
        currentModifiedMs: stat.mtimeMs,
      });
      return;
    }

    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      const after = fs.statSync(filePath);
      logger.info({ filePath, bytes: Buffer.byteLength(content) }, 'PUT /file wrote document');
      res.json({ ok: true, path: filePath, modifiedMs: after.mtimeMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, filePath }, 'PUT /file write failed');
      res.status(500).json({ error: message });
    }
  });

  return router;
}
