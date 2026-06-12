import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hookInstallerService } from '../services/hook-installer-service';
import type { SkillDirectoryService } from '../services/skill-directory-service';
import { getAggregateTotals, getDailyCosts } from '../services/usage-service';
import { scanSkills, type ScannedSkill } from '../skill-scanner';
import { findJsonlFile, getFormattedConversation } from '../services/transcript-service';
import { pathWithinRoots } from '../security/path-allow';
import { createDocWriter } from '../services/doc-writer';
import { buildCatalog } from '../agents/registry';
import type { ConfigService } from '../services/config-service';
import { getModelBreakdown, getModelMix, getCostPerGoal } from '../services/analytics-model-service';
import { getProviderValue, getWindowUtilization } from '../services/analytics-value-service';
import type { ProviderConfig } from '../../src/shared/agents/provider-config';
import logger from '../logger';

export interface SystemRouterConfig {
  /** Directories under which skill/agent .md files may be read. */
  skillRoots?: string[];
  /** When present, GET/PUT /config persist via this service instead of stubbing. */
  configService?: ConfigService;
  /** Override the provider list (tests). Falls back to configService's providers. */
  getProviders?: () => ProviderConfig[];
}

/** Default skill roots: project + user .claude surfaces (mirrors skill-scanner). */
function defaultSkillRoots(): string[] {
  const roots: string[] = [];
  for (const surface of ['skills', 'agents', 'hooks', 'commands']) {
    roots.push(path.join(process.cwd(), '.claude', surface));
    roots.push(path.join(os.homedir(), '.claude', surface));
  }
  return roots;
}

/**
 * Creates the system router. Accepts an optional SkillDirectoryService
 * for the skill-directories CRUD endpoints, and optional skill roots that
 * constrain which .md files /skill-content may read.
 */
export function createSystemRouter(skillDirService?: SkillDirectoryService, config?: SystemRouterConfig): Router {
const router = Router();
const skillRoots = config?.skillRoots ?? defaultSkillRoots();
const docWriter = createDocWriter();
const configService = config?.configService;

// Provider list for billing-aware analytics: explicit override (tests) →
// persisted config → single-claude-seat default.
const getProviders: () => ProviderConfig[] =
  config?.getProviders ??
  (() => configService?.getPersisted().providers ?? [{ id: 'claude', enabled: true, billingMode: 'seat' }]);

/** The single billing label for endpoints that report one: metered-anywhere → cost, else equivalent_value. */
function primaryLabel(): 'cost' | 'equivalent_value' {
  const enabled = getProviders().filter((p) => p.enabled);
  return enabled.some((p) => p.billingMode === 'metered') ? 'cost' : 'equivalent_value';
}

type WithDb = { locals: { db: import('better-sqlite3').Database } };

/** GET /api/analytics/model-breakdown?days=N */
router.get('/analytics/model-breakdown', (req, res) => {
  try {
    const db = (req.app as unknown as WithDb).locals?.db;
    if (!db) { res.json({ label: primaryLabel(), models: [] }); return; }
    const days = Math.max(0, Number(req.query['days'] ?? 30));
    res.json({ label: primaryLabel(), models: getModelBreakdown(db, days) });
  } catch (err) {
    logger.error({ err: String(err) }, 'model-breakdown failed');
    res.json({ label: 'equivalent_value', models: [] });
  }
});

/** GET /api/analytics/model-mix?days=N&bucket=day */
router.get('/analytics/model-mix', (req, res) => {
  try {
    const db = (req.app as unknown as WithDb).locals?.db;
    if (!db) { res.json({ label: primaryLabel(), series: [] }); return; }
    const days = Math.max(0, Number(req.query['days'] ?? 30));
    res.json({ label: primaryLabel(), series: getModelMix(db, days, 'day') });
  } catch (err) {
    logger.error({ err: String(err) }, 'model-mix failed');
    res.json({ label: 'equivalent_value', series: [] });
  }
});

/** GET /api/analytics/value?days=N */
router.get('/analytics/value', (req, res) => {
  try {
    const db = (req.app as unknown as WithDb).locals?.db;
    if (!db) { res.json({ providers: [] }); return; }
    const days = Math.max(0, Number(req.query['days'] ?? 30));
    res.json({ providers: getProviderValue(db, days, getProviders()) });
  } catch (err) {
    logger.error({ err: String(err) }, 'value failed');
    res.json({ providers: [] });
  }
});

/** GET /api/analytics/window-utilization (seat only) */
router.get('/analytics/window-utilization', (req, res) => {
  try {
    const db = (req.app as unknown as WithDb).locals?.db;
    if (!db) { res.json({ rows: [] }); return; }
    res.json({ rows: getWindowUtilization(db, getProviders()) });
  } catch (err) {
    logger.error({ err: String(err) }, 'window-utilization failed');
    res.json({ rows: [] });
  }
});

/** GET /api/analytics/cost-per-goal?days=N */
router.get('/analytics/cost-per-goal', (req, res) => {
  try {
    const db = (req.app as unknown as WithDb).locals?.db;
    if (!db) { res.json({ label: primaryLabel(), series: [] }); return; }
    const days = Math.max(0, Number(req.query['days'] ?? 30));
    res.json({ label: primaryLabel(), series: getCostPerGoal(db, days) });
  } catch (err) {
    logger.error({ err: String(err) }, 'cost-per-goal failed');
    res.json({ label: 'equivalent_value', series: [] });
  }
});

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
 * GET /api/agents
 * Scans for Claude Code agent definitions in known locations.
 * Agents are .md files found in .claude/agents/ directories.
 */
router.get('/agents', (req, res) => {
  const extraDirs: string[] = [];
  const dirParam = req.query['dir'];
  if (typeof dirParam === 'string' && dirParam.length > 0) {
    for (const d of dirParam.split(',')) {
      const trimmed = d.trim();
      if (trimmed) extraDirs.push(trimmed);
    }
  }

  // scanSkills already scans 'agents' as a surface type — just filter by type
  const all = scanSkills({ extraDirs });
  const agents = all.filter((s: ScannedSkill) => s.type === 'agents');
  res.json(agents);
});

/**
 * GET /api/skill-content?path=<encoded-path>
 * Reads a skill/agent .md file and returns its content.
 * The path must end in .md and must exist on disk.
 */
router.get('/skill-content', (req, res) => {
  const filePath = req.query['path'];
  if (typeof filePath !== 'string' || filePath.length === 0) {
    res.status(400).json({ error: 'path query parameter is required' });
    return;
  }
  if (!filePath.endsWith('.md')) {
    res.status(400).json({ error: 'Only .md files can be read' });
    return;
  }
  // Containment: the resolved path must live within a known skill root. This
  // replaces the old substring '..' check (which allowed any absolute .md path).
  if (!pathWithinRoots(filePath, skillRoots)) {
    logger.warn({ filePath }, 'skill-content rejected: outside skill roots');
    res.status(403).json({ error: 'Path is outside the allowed skill directories' });
    return;
  }
  try {
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content, path: filePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'Failed to read skill content');
    res.status(500).json({ error: message });
  }
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
 * Returns the persisted app configuration, runtime fields (dataDir,
 * hooksInstalled), and the provider catalog (with capabilities).
 */
router.get('/config', async (_req, res) => {
  if (!configService) {
    // Legacy stub for routers built without a config service (some tests).
    res.json({ homeRoute: '/board', defaultModel: 'default', defaultPermissionMode: 'supervised', tracePruneDays: 90 });
    return;
  }
  const persisted = configService.getPersisted();
  const status = await hookInstallerService.status();
  const enabledIds = persisted.providers.filter((p) => p.enabled).map((p) => p.id);
  res.json({
    ...persisted,
    dataDir: process.env['DATA_DIR'] ?? './data',
    hooksInstalled: status.installed,
    catalog: buildCatalog(enabledIds),
  });
});

/**
 * PUT /api/config
 * Persists a partial config update and returns the merged result + catalog.
 * Invalid bodies (Zod failure) return 400 and write nothing.
 */
router.put('/config', (req, res) => {
  if (!configService) {
    logger.info({ config: req.body }, 'Config update received (no persistence configured)');
    res.json({ ...req.body, updated: true });
    return;
  }
  try {
    const updated = configService.updatePersisted(req.body ?? {});
    const enabledIds = updated.providers.filter((p) => p.enabled).map((p) => p.id);
    res.json({ ...updated, catalog: buildCatalog(enabledIds) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
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
 * GET /api/analytics/totals?days=30
 * Returns aggregate totals computed from Claude Code JSONL session logs.
 * tokensIn = input + cache_creation + cache_read (matches Kanban card convention).
 * days=0 means all time.
 */
router.get('/analytics/totals', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    const days = Math.max(0, Number(req.query['days'] ?? 0));

    if (db) {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage'").get();
      if (hasTable) {
        const whereClause = days > 0 ? `WHERE first_message_at > ${Date.now() - days * 86400000}` : '';
        const row = db.prepare(`
          SELECT COUNT(*) as sessions, COALESCE(SUM(estimated_cost_usd), 0) as cost,
            COALESCE(SUM(input_tokens + cache_creation_tokens + cache_read_tokens), 0) as tokensIn,
            COALESCE(SUM(output_tokens), 0) as tokensOut
          FROM session_usage ${whereClause}
        `).get() as { sessions: number; cost: number; tokensIn: number; tokensOut: number };
        res.json({ sessions: row.sessions, cost: Math.round(row.cost * 10000) / 10000, tokensIn: row.tokensIn, tokensOut: row.tokensOut });
        return;
      }
    }

    const totals = getAggregateTotals(days);
    res.json(totals);
  } catch {
    res.json({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 });
  }
});

/**
 * GET /api/analytics/tool-usage?days=30
 * Returns tool usage counts from hook events.
 */
router.get('/analytics/tool-usage', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) {
      res.json([]);
      return;
    }
    const days = Math.max(0, parseInt(String(req.query['days'] ?? '0'), 10) || 0);
    const dateClause = days > 0
      ? `AND created_at > (strftime('%s', 'now', '-${days} days') * 1000)`
      : '';
    const rows = db.prepare(`
      SELECT tool_name as name, COUNT(*) as count
      FROM hook_events
      WHERE tool_name IS NOT NULL AND event_type IN ('PreToolUse', 'PostToolUse')
      ${dateClause}
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
 * GET /api/analytics/daily-costs?days=30
 * Returns daily cost aggregates computed from Claude Code JSONL session logs.
 * days=0 means all time.
 */
router.get('/analytics/daily-costs', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    const days = Math.max(0, Number(req.query['days'] ?? 0));

    if (db) {
      const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage'").get();
      if (hasTable) {
        const whereClause = days > 0 ? `WHERE first_message_at > ${Date.now() - days * 86_400_000}` : '';
        const rows = db.prepare(`
          SELECT session_date as date, COALESCE(SUM(estimated_cost_usd), 0) as cost, COUNT(*) as sessions
          FROM session_usage ${whereClause}
          GROUP BY session_date
          ORDER BY session_date
        `).all() as Array<{ date: string; cost: number; sessions: number }>;
        res.json(rows.map(r => ({ date: r.date, cost: Math.round(r.cost * 10000) / 10000, sessions: r.sessions })));
        return;
      }
    }

    const rows = getDailyCosts(days);
    res.json(rows);
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/goals/:id/documents
 * Lists all .md files in the goal's cwd directory.
 */
router.get('/goals/:id/documents', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) { res.status(500).json({ error: 'Database not available' }); return; }

    const goalId = String(req.params['id']);
    const goal = db.prepare('SELECT cwd FROM goals WHERE id = ?').get(goalId) as { cwd: string } | undefined;
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }

    if (!fs.existsSync(goal.cwd)) { res.json({ files: [] }); return; }

    const entries = fs.readdirSync(goal.cwd);
    const mdFiles = entries
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .sort();
    if (!mdFiles.includes('conversation.md') && findJsonlFile(goalId) !== null) {
      mdFiles.unshift('conversation.md');
    }
    res.json({ files: mdFiles });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/goals/:id/document?name=plan.md&tail=500
 * Reads a document file from the goal's cwd.
 * Optional tail param returns last N lines with hasMore/totalLines metadata.
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

    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    const goal = db.prepare('SELECT cwd FROM goals WHERE id = ?').get(goalId) as { cwd: string } | undefined;
    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    // Virtual document: conversation.md reads from JSONL, not filesystem
    if (fileName === 'conversation.md') {
      const tail = parseInt(String(req.query['tail'] ?? '0'), 10);
      const offset = parseInt(String(req.query['offset'] ?? '0'), 10);
      const result = getFormattedConversation(goalId, { tail, offset });
      if (!result) {
        res.json({ exists: false, content: null, name: fileName });
        return;
      }
      res.json({ exists: true, content: result.content, name: fileName, totalLines: result.totalLines, hasMore: result.hasMore });
      return;
    }

    const filePath = path.join(goal.cwd, fileName);
    if (!fs.existsSync(filePath)) {
      res.json({ exists: false, content: null, name: fileName });
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const tail = parseInt(String(req.query['tail'] ?? '0'), 10);
    const offset = parseInt(String(req.query['offset'] ?? '0'), 10);

    if (tail > 0) {
      const lines = content.split('\n');
      const totalLines = lines.length;
      const end = Math.max(0, totalLines - offset);
      const start = Math.max(0, end - tail);
      const sliced = lines.slice(start, end).join('\n');
      res.json({ exists: true, content: sliced, name: fileName, totalLines, hasMore: start > 0 });
    } else {
      // Expose the resolved path + mtime so the markdown editor can save via
      // PUT /api/file (goal cwds are editable roots) with conflict detection.
      const modifiedMs = fs.statSync(filePath).mtimeMs;
      res.json({ exists: true, content, name: fileName, path: filePath, modifiedMs });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/goals/:id/document — attributed write of a .md doc into the goal's cwd (5F).
 * Body: { name, content, baseHash, author? }. 409 on a stale baseHash (last-write-wins),
 * stamping an attribution trailer on success.
 */
router.post('/goals/:id/document', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) {
      res.status(500).json({ error: 'Database not available' });
      return;
    }
    const goalId = String(req.params['id']);
    const { name, content, baseHash, author } = (req.body ?? {}) as {
      name?: string;
      content?: string;
      baseHash?: string;
      author?: string;
    };
    if (typeof name !== 'string' || !name || typeof content !== 'string') {
      res.status(400).json({ error: 'name and content are required' });
      return;
    }
    if (!name.endsWith('.md') || name.includes('..') || name.includes('/') || name.includes('\\')) {
      res.status(400).json({ error: 'Invalid filename (.md only, no path separators)' });
      return;
    }
    const goal = db.prepare('SELECT cwd FROM goals WHERE id = ?').get(goalId) as
      | { cwd: string }
      | undefined;
    if (!goal) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }
    const filePath = path.join(goal.cwd, name);
    const result = docWriter.writeWithAttribution({
      path: filePath,
      content,
      baseHash: baseHash ?? '',
      author: author ?? `goal-${goalId.slice(0, 8)}/claude`,
    });
    if (result.conflict) {
      res.status(409).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/analytics/activity-heatmap?days=90
 * Returns session counts per day (for GitHub-style heatmap).
 * days=0 means all time.
 */
router.get('/analytics/activity-heatmap', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) { res.json([]); return; }
    const days = Math.max(0, Number(req.query['days'] ?? 0));
    const dateClause = days > 0
      ? `WHERE started_at > (strftime('%s', 'now', '-${days} days') * 1000)`
      : '';
    const rows = db.prepare(`
      SELECT date(started_at / 1000, 'unixepoch') as date, COUNT(*) as count
      FROM sessions
      ${dateClause}
      GROUP BY date(started_at / 1000, 'unixepoch')
      ORDER BY date
    `).all();
    res.json(rows);
  } catch { res.json([]); }
});

/**
 * GET /api/analytics/sessions-per-day?days=30
 * Returns daily session counts for trend chart.
 * days=0 means all time.
 */
router.get('/analytics/sessions-per-day', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) { res.json([]); return; }
    const days = Math.max(0, Number(req.query['days'] ?? 0));
    const dateClause = days > 0
      ? `WHERE started_at > (strftime('%s', 'now', '-${days} days') * 1000)`
      : '';
    const rows = db.prepare(`
      SELECT date(started_at / 1000, 'unixepoch') as date, COUNT(*) as sessions,
        SUM(CASE WHEN origin = 'dashboard' THEN 1 ELSE 0 END) as dashboard,
        SUM(CASE WHEN origin = 'external' THEN 1 ELSE 0 END) as external
      FROM sessions
      ${dateClause}
      GROUP BY date(started_at / 1000, 'unixepoch')
      ORDER BY date
    `).all();
    res.json(rows);
  } catch { res.json([]); }
});

/**
 * GET /api/analytics/session-durations?days=30
 * Returns session duration distribution buckets.
 * days=0 means all time.
 */
router.get('/analytics/session-durations', (req, res) => {
  try {
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;
    if (!db) { res.json([]); return; }
    const days = Math.max(0, Number(req.query['days'] ?? 0));
    const dateClause = days > 0
      ? `AND started_at > (strftime('%s', 'now', '-${days} days') * 1000)`
      : '';
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
      ${dateClause}
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

// ── Phase 2: Output Trends Endpoints ──────────────────────────────────────

const analyticsCache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000;

function getCached<T>(key: string): T | null {
  const entry = analyticsCache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data as T;
  analyticsCache.delete(key);
  return null;
}

function setCache(key: string, data: unknown): void {
  analyticsCache.set(key, { data, expires: Date.now() + CACHE_TTL });
}

/**
 * GET /api/analytics/jira-stories?days=N
 * Returns Jira stories completed grouped by week: [{ date, count }].
 * Returns [] when Jira credentials are not configured.
 */
router.get('/analytics/jira-stories', async (req, res) => {
  try {
    const days = Math.max(0, Number(req.query['days'] ?? 30));
    const cacheKey = `jira-stories-${days}`;
    const cached = getCached<Array<{ date: string; count: number }>>(cacheKey);
    if (cached) { res.json(cached); return; }

    const username = process.env['JIRA_USERNAME'];
    const token = process.env['JIRA_API_TOKEN'];
    const baseUrl = process.env['JIRA_BASE_URL'];

    if (!username || !token || !baseUrl) {
      setCache(cacheKey, []);
      res.json([]);
      return;
    }

    const jql = `assignee = currentUser() AND status changed to Done AFTER -${days || 365}d`;
    const response = await fetch(
      `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=resolutiondate&maxResults=1000`,
      { headers: { 'Authorization': `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`, 'Accept': 'application/json' } },
    );

    if (!response.ok) {
      setCache(cacheKey, []);
      res.json([]);
      return;
    }

    const data = await response.json() as { issues?: Array<{ fields?: { resolutiondate?: string } }> };
    const weekCounts = new Map<string, number>();

    for (const issue of data.issues ?? []) {
      const resolved = issue.fields?.resolutiondate;
      if (!resolved) continue;
      const d = new Date(resolved);
      d.setDate(d.getDate() - d.getDay());
      const weekStart = d.toISOString().split('T')[0];
      weekCounts.set(weekStart, (weekCounts.get(weekStart) ?? 0) + 1);
    }

    const result = [...weekCounts.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    setCache(cacheKey, result);
    res.json(result);
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/analytics/prs-merged?days=N
 * Returns PRs merged grouped by week: [{ date, count }].
 * Returns [] when GitHub CLI is unavailable.
 */
router.get('/analytics/prs-merged', async (req, res) => {
  try {
    const days = Math.max(0, Number(req.query['days'] ?? 30));
    const cacheKey = `prs-merged-${days}`;
    const cached = getCached<Array<{ date: string; count: number }>>(cacheKey);
    if (cached) { res.json(cached); return; }

    const { execSync } = await import('node:child_process');
    let output: string;
    try {
      const since = new Date(Date.now() - (days || 365) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      output = execSync(
        `gh pr list --author @me --state merged --search "merged:>=${since}" --json mergedAt --limit 1000`,
        { encoding: 'utf-8', timeout: 15000 },
      );
    } catch {
      setCache(cacheKey, []);
      res.json([]);
      return;
    }

    const prs = JSON.parse(output) as Array<{ mergedAt?: string }>;
    const weekCounts = new Map<string, number>();

    for (const pr of prs) {
      if (!pr.mergedAt) continue;
      const d = new Date(pr.mergedAt);
      d.setDate(d.getDate() - d.getDay());
      const weekStart = d.toISOString().split('T')[0];
      weekCounts.set(weekStart, (weekCounts.get(weekStart) ?? 0) + 1);
    }

    const result = [...weekCounts.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    setCache(cacheKey, result);
    res.json(result);
  } catch {
    res.json([]);
  }
});

/**
 * GET /api/analytics/context-inventory?days=N
 * Returns context items (skills, MCP servers, plugins, hooks) with usage counts.
 */
router.get('/analytics/context-inventory', (req, res) => {
  try {
    const days = Math.max(0, Number(req.query['days'] ?? 0));
    const db = (req.app as unknown as { locals: { db: import('better-sqlite3').Database } }).locals?.db;

    const usageMap = new Map<string, { count: number; lastUsed: number }>();
    if (db) {
      const dateClause = days > 0
        ? `AND created_at > (strftime('%s', 'now', '-${days} days') * 1000)`
        : '';
      const rows = db.prepare(`
        SELECT tool_name, COUNT(*) as count, MAX(created_at) as lastUsed
        FROM hook_events
        WHERE tool_name IS NOT NULL AND event_type IN ('PreToolUse', 'PostToolUse')
        ${dateClause}
        GROUP BY tool_name
      `).all() as Array<{ tool_name: string; count: number; lastUsed: number }>;
      for (const row of rows) {
        usageMap.set(row.tool_name, { count: row.count, lastUsed: row.lastUsed });
      }
    }

    interface ContextItem {
      name: string;
      type: string;
      usageCount: number;
      lastUsed: number | null;
      estimatedSize: number;
    }

    const items: ContextItem[] = [];

    const perSkillUsage = new Map<string, { count: number; lastUsed: number }>();
    if (db) {
      const dateClause2 = days > 0
        ? `AND created_at > (strftime('%s', 'now', '-${days} days') * 1000)`
        : '';
      const skillRows = db.prepare(`
        SELECT json_extract(payload_json, '$.tool_input.skill') as skill_name, COUNT(*) as count, MAX(created_at) as lastUsed
        FROM hook_events
        WHERE tool_name = 'Skill' AND event_type IN ('PreToolUse', 'PostToolUse')
        AND json_extract(payload_json, '$.tool_input.skill') IS NOT NULL
        ${dateClause2}
        GROUP BY skill_name
      `).all() as Array<{ skill_name: string; count: number; lastUsed: number }>;
      for (const row of skillRows) {
        perSkillUsage.set(row.skill_name, { count: row.count, lastUsed: row.lastUsed });
      }
    }

    const skills = scanSkills({});
    for (const skill of skills) {
      if (skill.type === 'agents') continue;
      let estimatedSize = 0;
      try {
        if (fs.existsSync(skill.path)) {
          estimatedSize = fs.readFileSync(skill.path, 'utf-8').length;
        }
      } catch { /* skip */ }
      const usage = perSkillUsage.get(skill.name) ?? { count: 0, lastUsed: 0 };
      items.push({
        name: skill.name,
        type: 'skill',
        usageCount: usage.count,
        lastUsed: usage.lastUsed || null,
        estimatedSize,
      });
    }

    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(raw) as Record<string, unknown>;

        const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
        for (const serverName of Object.keys(mcpServers)) {
          let totalCount = 0;
          let lastUsed: number | null = null;
          for (const [toolName, usage] of usageMap.entries()) {
            if (toolName.startsWith(`mcp__${serverName}__`)) {
              totalCount += usage.count;
              if (lastUsed === null || usage.lastUsed > lastUsed) lastUsed = usage.lastUsed;
            }
          }
          items.push({ name: serverName, type: 'mcp', usageCount: totalCount, lastUsed, estimatedSize: 0 });
        }

        const plugins = (settings.enabledPlugins ?? {}) as Record<string, boolean>;
        for (const [name, enabled] of Object.entries(plugins)) {
          if (!enabled) continue;
          items.push({ name, type: 'plugin', usageCount: 0, lastUsed: null, estimatedSize: 0 });
        }

        const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
        for (const hookType of Object.keys(hooks)) {
          items.push({ name: hookType, type: 'hook', usageCount: 0, lastUsed: null, estimatedSize: 0 });
        }
      }
    } catch { /* settings not available */ }

    res.json(items);
  } catch {
    res.json([]);
  }
});

return router;
}

// Default export for backward compatibility (routes that don't need skill-directories)
export default createSystemRouter();
