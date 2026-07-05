import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hookInstallerService } from '../services/hook-installer-service';
import type { SkillDirectoryService } from '../services/skill-directory-service';
import { scanSkills, type ScannedSkill } from '../skill-scanner';
import { findJsonlFile, getFormattedConversation } from '../services/transcript-service';
import { pathWithinRoots } from '../security/path-allow';
import { createDocWriter } from '../services/doc-writer';
import { buildCatalog } from '../agents/registry';
import { claudeModelsService, type ClaudeModelsService } from '../services/claude-models-service';
import { codexModelsService, type CodexModelsService } from '../services/codex-models-service';
import {
  antigravityModelsService,
  type AntigravityModelsService,
} from '../services/antigravity-models-service';
import type { AgentCatalogEntry } from '../../src/shared/agents/types';
import type { ConfigService } from '../services/config-service';
import logger from '../logger';

export interface SystemRouterConfig {
  /** Directories under which skill/agent .md files may be read. */
  skillRoots?: string[];
  /** When present, GET/PUT /config persist via this service instead of stubbing. */
  configService?: ConfigService;
  /** Called after a successful PUT /config so callers can react (e.g. sync the Headroom proxy). */
  onConfigUpdated?: (updated: ReturnType<ConfigService['updatePersisted']>) => void;
  /** Live Anthropic model-list service for the catalog overlay (tests inject a stub). */
  claudeModels?: ClaudeModelsService;
  /** Live Codex model-list service (reads ~/.codex/models_cache.json; tests stub). */
  codexModels?: CodexModelsService;
  /** Live Antigravity model-list service (runs `agy models` via PTY; tests stub). */
  antigravityModels?: AntigravityModelsService;
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
const claudeModels = config?.claudeModels ?? claudeModelsService;
const codexModels = config?.codexModels ?? codexModelsService;
const antigravityModels = config?.antigravityModels ?? antigravityModelsService;

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
 * Builds the provider catalog and overlays each provider's live model list onto its
 * entry: Claude from the Anthropic API, Codex from ~/.codex/models_cache.json. Each
 * provider independently falls back to its static registry-derived models when its
 * live list is unavailable. (Antigravity has no server-readable live source — its
 * models are baked into the agy binary — so it keeps the static list.)
 */
async function buildCatalogWithLiveModels(enabledIds: string[]): Promise<AgentCatalogEntry[]> {
  const catalog = buildCatalog(enabledIds);
  const [liveClaude, liveCodex, liveAntigravity] = await Promise.all([
    claudeModels.getModelOptions(),
    codexModels.getModelOptions(),
    antigravityModels.getModelOptions(),
  ]);
  return catalog.map((entry) => {
    if (entry.id === 'claude' && liveClaude) return { ...entry, models: liveClaude };
    if (entry.id === 'codex' && liveCodex) return { ...entry, models: liveCodex };
    if (entry.id === 'antigravity' && liveAntigravity) return { ...entry, models: liveAntigravity };
    return entry;
  });
}

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
    catalog: await buildCatalogWithLiveModels(enabledIds),
  });
});

/**
 * PUT /api/config
 * Persists a partial config update and returns the merged result + catalog.
 * Invalid bodies (Zod failure) return 400 and write nothing.
 */
router.put('/config', async (req, res) => {
  if (!configService) {
    logger.info({ config: req.body }, 'Config update received (no persistence configured)');
    res.json({ ...req.body, updated: true });
    return;
  }
  try {
    const updated = configService.updatePersisted(req.body ?? {});
    config?.onConfigUpdated?.(updated);
    const enabledIds = updated.providers.filter((p) => p.enabled).map((p) => p.id);
    res.json({ ...updated, catalog: await buildCatalogWithLiveModels(enabledIds) });
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
