import { Router } from 'express';
import type { Request } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getAggregateTotals, getDailyCosts } from '../services/usage-service';
import { scanSkills } from '../skill-scanner';
import { getModelBreakdown, getModelMix, getCostPerGoal } from '../services/analytics-model-service';
import { getProviderValue, getWindowUtilization } from '../services/analytics-value-service';
import type { ConfigService } from '../services/config-service';
import type { ProviderConfig } from '../../src/shared/agents/provider-config';
import logger from '../logger';

export interface AnalyticsRouterConfig {
  /** When present, headroom-stats reads the Headroom proxy settings from here. */
  configService?: ConfigService;
  /** Override the provider list (tests). Falls back to configService's providers. */
  getProviders?: () => ProviderConfig[];
}

type Db = import('better-sqlite3').Database;

/**
 * Creates the analytics router (all GET /api/analytics/* endpoints).
 *
 * Every endpoint is fail-open: missing db, upstream errors, or unexpected
 * exceptions all yield the endpoint's empty shape with HTTP 200 — panels
 * never branch on error responses.
 */
export function createAnalyticsRouter(config?: AnalyticsRouterConfig): Router {
  const router = Router();
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

  // 5-minute response cache for the expensive external lookups (Jira / GitHub).
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

  interface EndpointCtx {
    /** app.locals.db; defined when requireDb is set. */
    db: Db | undefined;
    /** Parsed non-negative ?days= (0 = all time). */
    days: number;
    req: Request;
  }

  /**
   * Shared handler boilerplate for /analytics/* endpoints: reads the db from
   * app.locals (fail-open `empty` when absent and requireDb is set), parses the
   * `days` query param, and wraps the handler in a try/catch that logs and
   * fail-opens to the empty shape. The handler's return value is the JSON body.
   */
  function endpoint(
    route: string,
    opts: {
      /** Respond with empty() when app.locals.db is missing. */
      requireDb?: boolean;
      /** Default for ?days= (0 = all time). */
      daysDefault?: number;
      /** Empty shape when db is missing (fail-open). */
      empty: () => unknown;
      /** Empty shape on thrown error; defaults to empty(). */
      emptyOnError?: () => unknown;
      handle: (ctx: EndpointCtx) => unknown;
    },
  ): void {
    const name = route.replace('/analytics/', '');
    router.get(route, async (req, res) => {
      try {
        const db = (req.app as unknown as { locals: { db: Db } }).locals?.db;
        if (opts.requireDb && !db) {
          res.json(opts.empty());
          return;
        }
        const days = Math.max(0, Number(req.query['days'] ?? (opts.daysDefault ?? 0)));
        res.json(await opts.handle({ db, days, req }));
      } catch (err) {
        logger.error({ err: String(err) }, `${name} failed`);
        res.json((opts.emptyOnError ?? opts.empty)());
      }
    });
  }

  /** GET /api/analytics/model-breakdown?days=N */
  endpoint('/analytics/model-breakdown', {
    requireDb: true,
    daysDefault: 30,
    empty: () => ({ label: primaryLabel(), models: [] }),
    emptyOnError: () => ({ label: 'equivalent_value', models: [] }),
    handle: ({ db, days }) => ({ label: primaryLabel(), models: getModelBreakdown(db as Db, days) }),
  });

  /** GET /api/analytics/model-mix?days=N&bucket=day */
  endpoint('/analytics/model-mix', {
    requireDb: true,
    daysDefault: 30,
    empty: () => ({ label: primaryLabel(), series: [] }),
    emptyOnError: () => ({ label: 'equivalent_value', series: [] }),
    handle: ({ db, days }) => ({ label: primaryLabel(), series: getModelMix(db as Db, days, 'day') }),
  });

  /** GET /api/analytics/value?days=N */
  endpoint('/analytics/value', {
    requireDb: true,
    daysDefault: 30,
    empty: () => ({ providers: [] }),
    handle: ({ db, days }) => ({ providers: getProviderValue(db as Db, days, getProviders()) }),
  });

  /**
   * GET /api/analytics/headroom-stats
   * Relays a small slice of the local Headroom proxy's /stats. Fail-open to zeros
   * when disabled or unreachable — the panel never branches on missing data.
   */
  const HEADROOM_EMPTY = () => ({
    enabled: false,
    requests: 0,
    totalInputTokens: 0,
    tokensSaved: 0,
    savingsPercent: 0,
    compressionSavingsUsd: 0,
    avgCompressionPct: 0,
    bestCompressionPct: 0,
    cacheHitRate: 0,
    netTokens: 0,
    lifetimeTokensSaved: 0,
    savingsHistory: [] as unknown[],
  });
  endpoint('/analytics/headroom-stats', {
    empty: HEADROOM_EMPTY,
    handle: async () => {
      const h = configService?.getPersisted().headroom;
      if (!h?.enabled) return HEADROOM_EMPTY();
      const r = await fetch(`${h.baseUrl}/stats`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return HEADROOM_EMPTY();
      const s = (await r.json()) as Record<string, unknown>;
      const ps = (s['persistent_savings'] ?? {}) as Record<string, unknown>;
      const ds = (ps['display_session'] ?? {}) as Record<string, unknown>;
      const life = (ps['lifetime'] ?? {}) as Record<string, unknown>;
      const summary = (s['summary'] ?? {}) as Record<string, unknown>;
      const comp = (summary['compression'] ?? {}) as Record<string, unknown>;
      const prefix = (s['prefix_cache'] ?? {}) as Record<string, unknown>;
      const totals = (prefix['totals'] ?? {}) as Record<string, unknown>;
      const cvc = (prefix['compression_vs_cache'] ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      return {
        enabled: true,
        requests: num(ds['requests']),
        totalInputTokens: num(ds['total_input_tokens']),
        tokensSaved: num(ds['tokens_saved']),
        savingsPercent: num(ds['savings_percent']),
        compressionSavingsUsd: num(ds['compression_savings_usd']),
        avgCompressionPct: num(comp['avg_compression_pct']),
        bestCompressionPct: num(comp['best_compression_pct']),
        cacheHitRate: num(totals['hit_rate']),
        netTokens: num(cvc['net_tokens']),
        lifetimeTokensSaved: num(life['tokens_saved']),
        savingsHistory: Array.isArray(s['savings_history']) ? (s['savings_history'] as unknown[]) : [],
      };
    },
  });

  /** GET /api/analytics/window-utilization (seat only) */
  endpoint('/analytics/window-utilization', {
    requireDb: true,
    empty: () => ({ rows: [] }),
    handle: ({ db }) => ({ rows: getWindowUtilization(db as Db, getProviders()) }),
  });

  /** GET /api/analytics/cost-per-goal?days=N */
  endpoint('/analytics/cost-per-goal', {
    requireDb: true,
    daysDefault: 30,
    empty: () => ({ label: primaryLabel(), series: [] }),
    emptyOnError: () => ({ label: 'equivalent_value', series: [] }),
    handle: ({ db, days }) => ({ label: primaryLabel(), series: getCostPerGoal(db as Db, days) }),
  });

  /**
   * GET /api/analytics/totals?days=30
   * Returns aggregate totals computed from Claude Code JSONL session logs.
   * tokensIn = input + cache_creation + cache_read (matches Kanban card convention).
   * days=0 means all time.
   */
  endpoint('/analytics/totals', {
    empty: () => ({ sessions: 0, cost: 0, tokensIn: 0, tokensOut: 0 }),
    handle: ({ db, days }) => {
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
          return { sessions: row.sessions, cost: Math.round(row.cost * 10000) / 10000, tokensIn: row.tokensIn, tokensOut: row.tokensOut };
        }
      }
      return getAggregateTotals(days);
    },
  });

  /**
   * GET /api/analytics/tool-usage?days=30
   * Returns tool usage counts from hook events.
   */
  endpoint('/analytics/tool-usage', {
    requireDb: true,
    empty: () => [],
    handle: ({ db, days }) => {
      const dateClause = days > 0
        ? `AND created_at > (strftime('%s', 'now', '-${days} days') * 1000)`
        : '';
      return (db as Db).prepare(`
        SELECT tool_name as name, COUNT(*) as count
        FROM hook_events
        WHERE tool_name IS NOT NULL AND event_type IN ('PreToolUse', 'PostToolUse')
        ${dateClause}
        GROUP BY tool_name
        ORDER BY count DESC
        LIMIT 20
      `).all();
    },
  });

  /**
   * GET /api/analytics/daily-costs?days=30
   * Returns daily cost aggregates computed from Claude Code JSONL session logs.
   * days=0 means all time.
   */
  endpoint('/analytics/daily-costs', {
    empty: () => [],
    handle: ({ db, days }) => {
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
          return rows.map(r => ({ date: r.date, cost: Math.round(r.cost * 10000) / 10000, sessions: r.sessions }));
        }
      }
      return getDailyCosts(days);
    },
  });

  /**
   * GET /api/analytics/activity-heatmap?days=90
   * Returns session counts per day (for GitHub-style heatmap).
   * days=0 means all time.
   */
  endpoint('/analytics/activity-heatmap', {
    requireDb: true,
    empty: () => [],
    handle: ({ db, days }) => {
      const dateClause = days > 0
        ? `WHERE started_at > (strftime('%s', 'now', '-${days} days') * 1000)`
        : '';
      return (db as Db).prepare(`
        SELECT date(started_at / 1000, 'unixepoch') as date, COUNT(*) as count
        FROM sessions
        ${dateClause}
        GROUP BY date(started_at / 1000, 'unixepoch')
        ORDER BY date
      `).all();
    },
  });

  /**
   * GET /api/analytics/sessions-per-day?days=30
   * Returns daily session counts for trend chart.
   * days=0 means all time.
   */
  endpoint('/analytics/sessions-per-day', {
    requireDb: true,
    empty: () => [],
    handle: ({ db, days }) => {
      const dateClause = days > 0
        ? `WHERE started_at > (strftime('%s', 'now', '-${days} days') * 1000)`
        : '';
      return (db as Db).prepare(`
        SELECT date(started_at / 1000, 'unixepoch') as date, COUNT(*) as sessions,
          SUM(CASE WHEN origin = 'dashboard' THEN 1 ELSE 0 END) as dashboard,
          SUM(CASE WHEN origin = 'external' THEN 1 ELSE 0 END) as external
        FROM sessions
        ${dateClause}
        GROUP BY date(started_at / 1000, 'unixepoch')
        ORDER BY date
      `).all();
    },
  });

  /**
   * GET /api/analytics/session-durations?days=30
   * Returns session duration distribution buckets.
   * days=0 means all time.
   */
  endpoint('/analytics/session-durations', {
    requireDb: true,
    empty: () => [],
    handle: ({ db, days }) => {
      const dateClause = days > 0
        ? `AND started_at > (strftime('%s', 'now', '-${days} days') * 1000)`
        : '';
      return (db as Db).prepare(`
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
    },
  });

  /**
   * GET /api/analytics/jira-stories?days=N
   * Returns Jira stories completed grouped by week: [{ date, count }].
   * Returns [] when Jira credentials are not configured.
   */
  endpoint('/analytics/jira-stories', {
    daysDefault: 30,
    empty: () => [],
    handle: async ({ days }) => {
      const cacheKey = `jira-stories-${days}`;
      const cached = getCached<Array<{ date: string; count: number }>>(cacheKey);
      if (cached) return cached;

      const username = process.env['JIRA_USERNAME'];
      const token = process.env['JIRA_API_TOKEN'];
      const baseUrl = process.env['JIRA_BASE_URL'];

      if (!username || !token || !baseUrl) {
        setCache(cacheKey, []);
        return [];
      }

      const jql = `assignee = currentUser() AND status changed to Done AFTER -${days || 365}d`;
      const response = await fetch(
        `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=resolutiondate&maxResults=1000`,
        { headers: { 'Authorization': `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`, 'Accept': 'application/json' } },
      );

      if (!response.ok) {
        setCache(cacheKey, []);
        return [];
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
      return result;
    },
  });

  /**
   * GET /api/analytics/prs-merged?days=N
   * Returns PRs merged grouped by week: [{ date, count }].
   * Returns [] when GitHub CLI is unavailable.
   */
  endpoint('/analytics/prs-merged', {
    daysDefault: 30,
    empty: () => [],
    handle: async ({ days }) => {
      const cacheKey = `prs-merged-${days}`;
      const cached = getCached<Array<{ date: string; count: number }>>(cacheKey);
      if (cached) return cached;

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
        return [];
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
      return result;
    },
  });

  /**
   * GET /api/analytics/context-inventory?days=N
   * Returns context items (skills, MCP servers, plugins, hooks) with usage counts.
   */
  endpoint('/analytics/context-inventory', {
    empty: () => [],
    handle: ({ db, days }) => {
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

      return items;
    },
  });

  return router;
}
