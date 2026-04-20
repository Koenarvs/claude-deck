import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hookInstallerService } from '../services/hook-installer-service';
import logger from '../logger';

const router = Router();

/**
 * GET /api/skills
 * Scans for Claude Code skills in known locations.
 */
router.get('/skills', (req, res) => {
  const skills: Array<{ name: string; description: string; scope: string; type: string; path: string }> = [];

  // Scan skills, agents, hooks, and commands directories
  const surfaceTypes = ['skills', 'agents', 'hooks', 'commands'] as const;
  const locations: Array<{ dir: string; scope: string; surfaceType: string }> = [];

  for (const surface of surfaceTypes) {
    locations.push({ dir: path.join(process.cwd(), '.claude', surface), scope: 'project', surfaceType: surface });
    locations.push({ dir: path.join(os.homedir(), '.claude', surface), scope: 'user', surfaceType: surface });
  }

  // ?dir= can be a single path or comma-separated list of paths to scan
  const extraDirs = req.query['dir'];
  if (typeof extraDirs === 'string' && extraDirs.length > 0) {
    for (const d of extraDirs.split(',')) {
      const trimmed = d.trim();
      if (trimmed) {
        // Support both direct .claude/skills path and project root path
        for (const surface of surfaceTypes) {
          const surfaceDir = path.join(trimmed, '.claude', surface);
          locations.push({ dir: surfaceDir, scope: 'custom', surfaceType: surface });
        }
      }
    }
  }

  for (const loc of locations) {
    try {
      if (!fs.existsSync(loc.dir)) continue;
      const entries = fs.readdirSync(loc.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = path.join(loc.dir, entry.name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            const content = fs.readFileSync(skillFile, 'utf-8');
            // Extract description from frontmatter
            const descMatch = content.match(/description:\s*(.+)/);
            const desc = descMatch ? descMatch[1].trim() : '';
            skills.push({
              name: entry.name,
              description: desc,
              scope: loc.scope,
              type: loc.surfaceType,
              path: skillFile,
            });
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = fs.readFileSync(path.join(loc.dir, entry.name), 'utf-8');
          const descMatch = content.match(/description:\s*(.+)/);
          const desc = descMatch ? descMatch[1].trim() : '';
          skills.push({
            name: entry.name.replace('.md', ''),
            description: desc,
            scope: loc.scope,
            type: loc.surfaceType,
            path: path.join(loc.dir, entry.name),
          });
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

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
 * Returns aggregate totals from sessions.
 */
router.get('/analytics/totals', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) {
      res.json({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
      return;
    }
    const row = db.prepare(`
      SELECT
        COUNT(*) as sessions,
        COALESCE(SUM(total_cost_usd), 0) as cost,
        COALESCE(SUM(total_tokens_in), 0) as tokensIn,
        COALESCE(SUM(total_tokens_out), 0) as tokensOut
      FROM sessions
    `).get() as Record<string, number>;
    res.json(row);
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
 * Returns daily cost aggregates from sessions.
 */
router.get('/analytics/daily-costs', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) {
      res.json([]);
      return;
    }
    const rows = db.prepare(`
      SELECT
        date(started_at / 1000, 'unixepoch') as date,
        COALESCE(SUM(total_cost_usd), 0) as cost,
        COUNT(*) as sessions
      FROM sessions
      WHERE started_at > (strftime('%s', 'now', '-30 days') * 1000)
      GROUP BY date(started_at / 1000, 'unixepoch')
      ORDER BY date
    `).all();
    res.json(rows);
  } catch {
    res.json([]);
  }
});

export default router;
