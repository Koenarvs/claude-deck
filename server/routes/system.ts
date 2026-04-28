import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hookInstallerService } from '../services/hook-installer-service';
import type { SkillDirectoryService } from '../services/skill-directory-service';
import { getAggregateTotals, getDailyCosts } from '../services/usage-service';
import { scanSkills } from '../skill-scanner';
import logger from '../logger';

/**
 * Creates the system router. Accepts an optional SkillDirectoryService
 * for the skill-directories CRUD endpoints.
 */
export function createSystemRouter(skillDirService?: SkillDirectoryService): Router {
const router = Router();

/**
 * GET /api/skills
 * Scans for Claude Code skills in known locations.
 */
router.get('/skills', (req, res) => {
  // ?dir= can be a single path or comma-separated list of paths to scan
  const extraDirs: string[] = [];
  const dirParam = req.query['dir'];
  if (typeof dirParam === 'string' && dirParam.length > 0) {
    for (const d of dirParam.split(',')) {
      const trimmed = d.trim();
      if (trimmed) extraDirs.push(trimmed);
    }
  }

  const skills = scanSkills({ extraDirs });
  res.json(skills);
});

/**
 * GET /api/extensions
 * Returns MCP servers, plugins, and hooks from Claude settings.
 */
router.get('/extensions', (_req, res) => {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (!fs.existsSync(settingsPath)) {
      res.json({ mcp: [], plugins: [], hooks: [] });
      return;
    }
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw) as Record<string, unknown>;

    const plugins = Object.entries(settings.enabledPlugins as Record<string, boolean> ?? {}).map(
      ([name, enabled]) => ({ name, enabled }),
    );

    const hookTypes = Object.keys(settings.hooks as Record<string, unknown> ?? {});

    res.json({
      mcp: [],
      plugins,
      hooks: hookTypes,
    });
  } catch {
    res.json({ mcp: [], plugins: [], hooks: [] });
  }
});

/**
 * GET /api/config
 * Returns the current app configuration.
 */
router.get('/config', (_req, res) => {
  res.json({
    homeRoute: '/board',
    defaultModel: 'default',
    defaultPermissionMode: 'supervised',
    traceRetentionDays: 90,
  });
});

/**
 * PUT /api/config
 * Updates app configuration.
 */
router.put('/config', (req, res) => {
  // For now, accept the update but don't persist (config persistence is a v1.1 feature)
  logger.info({ config: req.body }, 'Config update received');
  res.json({ ...req.body, updated: true });
});

/**
 * POST /api/system/install-hooks
 *
 * Installs claude-deck hooks into ~/.claude/settings.json.
 * Backs up existing settings, merges hooks (preserving other tools),
 * and writes atomically. Idempotent: running twice is safe.
 *
 * @returns {{ installed: boolean, backupPath: string | null }}
 */
router.post('/system/install-hooks', async (_req, res) => {
  try {
    const result = await hookInstallerService.install();
    logger.info({ result }, 'Hook install completed');
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Hook install failed');
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/system/uninstall-hooks
 *
 * Removes claude-deck hooks from ~/.claude/settings.json.
 * Restores the backup taken during install. Idempotent: running
 * uninstall when not installed is a safe no-op.
 *
 * @returns {{ uninstalled: boolean }}
 */
router.post('/system/uninstall-hooks', async (_req, res) => {
  try {
    const result = await hookInstallerService.uninstall();
    logger.info({ result }, 'Hook uninstall completed');
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Hook uninstall failed');
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/system/hook-status
 *
 * Returns whether claude-deck hooks are currently installed.
 *
 * @returns {{ installed: boolean, installedAt: number | null }}
 */
router.get('/system/hook-status', async (_req, res) => {
  try {
    const result = await hookInstallerService.status();
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Hook status check failed');
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/hook-events
 * Returns recent hook events from the database.
 */
router.get('/hook-events', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) {
      res.json([]);
      return;
    }
    const limit = Math.min(Number(req.query['limit'] ?? 500), 5000);
    const rows = db.prepare('SELECT * FROM hook_events ORDER BY created_at DESC LIMIT ?').all(limit);
    res.json(rows);
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/analytics/totals
 * Returns aggregate totals computed from Claude Code JSONL session logs.
 * tokensIn = input + cache_creation + cache_read (matches Kanban card convention).
 */
router.get('/analytics/totals', (_req, res) => {
  try {
    const totals = getAggregateTotals();
    res.json(totals);
  } catch {
    res.json({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
  }
});

/**
 * GET /api/analytics/tool-usage
 * Returns tool usage counts from hook events.
 */
router.get('/analytics/tool-usage', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) {
      res.json([]);
      return;
    }
    const rows = db.prepare(`
      SELECT tool_name as name, COUNT(*) as count
      FROM hook_events
      WHERE tool_name IS NOT NULL AND event_type IN ('PreToolUse', 'PostToolUse')
      GROUP BY tool_name
      ORDER BY count DESC
      LIMIT 20
    `).all();
    res.json(rows);
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/analytics/daily-costs
 * Returns daily cost aggregates computed from Claude Code JSONL session logs.
 * Covers the last 90 days (matches the heatmap range).
 */
router.get('/analytics/daily-costs', (_req, res) => {
  try {
    const rows = getDailyCosts(90);
    res.json(rows);
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/goals/:id/document?name=plan.md
 * Reads a document file from the goal's cwd.
 * Returns { content, exists } — content is null if file doesn't exist.
 */
router.get('/goals/:id/document', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) {
      res.status(500).json({ error: 'Database not available' });
      return;
    }

    const goalId = String(req.params['id']);
    const fileName = String(req.query['name'] ?? 'plan.md');

    // Validate filename — prevent path traversal
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const goal = db.prepare('SELECT cwd FROM goals WHERE id = ?').get(goalId) as { cwd: string } | undefined;
    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    const filePath = path.join(goal.cwd, fileName);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.json({ exists: true, content, name: fileName });
    } else {
      res.json({ exists: false, content: null, name: fileName });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/analytics/activity-heatmap
 * Returns session counts per day for the last 90 days (for GitHub-style heatmap).
 */
router.get('/analytics/activity-heatmap', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) { res.json([]); return; }
    const rows = db.prepare(`
      SELECT date(started_at / 1000, 'unixepoch') as date, COUNT(*) as count
      FROM sessions
      WHERE started_at > (strftime('%s', 'now', '-90 days') * 1000)
      GROUP BY date(started_at / 1000, 'unixepoch')
      ORDER BY date
    `).all();
    res.json(rows);
  } catch { res.json([]); }
});

/**
 * GET /api/analytics/sessions-per-day
 * Returns daily session counts for trend chart.
 */
router.get('/analytics/sessions-per-day', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) { res.json([]); return; }
    const rows = db.prepare(`
      SELECT date(started_at / 1000, 'unixepoch') as date, COUNT(*) as sessions,
        SUM(CASE WHEN origin = 'dashboard' THEN 1 ELSE 0 END) as dashboard,
        SUM(CASE WHEN origin = 'external' THEN 1 ELSE 0 END) as external
      FROM sessions
      WHERE started_at > (strftime('%s', 'now', '-30 days') * 1000)
      GROUP BY date(started_at / 1000, 'unixepoch')
      ORDER BY date
    `).all();
    res.json(rows);
  } catch { res.json([]); }
});

/**
 * GET /api/analytics/session-durations
 * Returns session duration distribution buckets.
 */
router.get('/analytics/session-durations', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) { res.json([]); return; }
    const rows = db.prepare(`
      SELECT
        CASE
          WHEN (ended_at - started_at) < 300000 THEN '< 5m'
          WHEN (ended_at - started_at) < 900000 THEN '5-15m'
          WHEN (ended_at - started_at) < 1800000 THEN '15-30m'
          WHEN (ended_at - started_at) < 3600000 THEN '30-60m'
          ELSE '60m+'
        END as bucket,
        COUNT(*) as count
      FROM sessions
      WHERE ended_at IS NOT NULL
      GROUP BY bucket
      ORDER BY MIN(ended_at - started_at)
    `).all();
    res.json(rows);
  } catch { res.json([]); }
});

// ── Skill Directory CRUD ──────────────────────────────────────────────────

/**
 * GET /api/skill-directories
 * Lists all configured skill directories.
 */
router.get('/skill-directories', (_req, res) => {
  if (!skillDirService) {
    res.status(501).json({ error: 'Skill directory service not available' });
    return;
  }
  try {
    const dirs = skillDirService.list();
    res.json(dirs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Failed to list skill directories');
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/skill-directories
 * Adds a new skill directory.
 * Body: { path: string, label?: string }
 */
router.post('/skill-directories', (req, res) => {
  if (!skillDirService) {
    res.status(501).json({ error: 'Skill directory service not available' });
    return;
  }
  try {
    const { path: dirPath, label } = req.body as { path?: string; label?: string };
    if (!dirPath || typeof dirPath !== 'string' || dirPath.trim().length === 0) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    const dir = skillDirService.add(dirPath.trim(), label);
    res.status(201).json(dir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // UNIQUE constraint violation → 409 Conflict
    if (message.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Directory already exists' });
      return;
    }
    logger.error({ err: message }, 'Failed to add skill directory');
    res.status(500).json({ error: message });
  }
});

/**
 * DELETE /api/skill-directories/:id
 * Removes a skill directory by ID.
 */
router.delete('/skill-directories/:id', (req, res) => {
  if (!skillDirService) {
    res.status(501).json({ error: 'Skill directory service not available' });
    return;
  }
  try {
    const id = Number(req.params['id']);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }
    const deleted = skillDirService.remove(id);
    if (deleted) {
      res.json({ deleted: true });
    } else {
      res.status(404).json({ error: 'Skill directory not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Failed to remove skill directory');
    res.status(500).json({ error: message });
  }
});

return router;
}

// Default export for backward compatibility (routes that don't need skill-directories)
export default createSystemRouter();
