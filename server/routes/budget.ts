import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { BudgetService } from '../services/budget-service';
import { readBudgetConfig } from '../services/budget-config';
import { recommendRoute, type WindowUtilizationEntry } from '../services/quota-router';
import { resolveModel } from '../../src/shared/agents/model-registry';
import logger from '../logger';

const KillSwitchSchema = z.object({ active: z.boolean() });

export interface BudgetRouterDeps {
  /** Live active-session counts per provider id. */
  activeSessionsByProvider: () => Record<string, number>;
  /** Phase 2 window-utilization feed; resolves to [] when unavailable. */
  fetchWindowUtilization: () => Promise<WindowUtilizationEntry[]>;
  /** Currently enabled provider ids. */
  enabledProviders: () => string[];
  /** Routing config (threshold + auto mode) from app config. */
  routingConfig: () => { hotThresholdPct: number; autoRoute: boolean };
  /** Live config reader for the status view (defaults to {} when omitted). */
  readConfig?: () => unknown;
}

export function createBudgetRouter(service: BudgetService, deps: BudgetRouterDeps): Router {
  const router = Router();

  router.get('/budget/status', (_req: Request, res: Response) => {
    try {
      const cfg = readBudgetConfig(deps.readConfig?.() ?? {});
      const active = deps.activeSessionsByProvider();
      const dailySpend = service.spentTodayUsd();
      const providers = Object.entries(cfg.providers).map(([id, p]) => ({
        id,
        billingMode: p.billingMode,
        spentTodayUsd: Math.round(dailySpend * 10000) / 10000,
        dailyCapUsd: p.budget.dailyUsd ?? null,
        overCap:
          p.billingMode === 'metered' && p.budget.dailyUsd != null && dailySpend >= p.budget.dailyUsd,
        activeSessions: active[id] ?? 0,
        maxConcurrent: p.maxConcurrent,
      }));
      res.json({ killSwitchActive: service.isKillSwitchActive(), providers });
    } catch (err) {
      logger.error({ err }, 'Failed to get budget status');
      res.status(500).json({ error: 'Failed to get budget status' });
    }
  });

  router.post('/budget/kill-switch', (req: Request, res: Response) => {
    const parsed = KillSwitchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'active (boolean) required' });
      return;
    }
    service.setKillSwitch(parsed.data.active);
    res.json({ killSwitchActive: service.isKillSwitchActive() });
  });

  router.get('/routing/recommendation', async (req: Request, res: Response) => {
    try {
      const model = String(req.query['model'] ?? '');
      if (!model) {
        res.status(400).json({ error: 'model query param required' });
        return;
      }
      const windowUtilization = await deps.fetchWindowUtilization();
      const { hotThresholdPct, autoRoute } = deps.routingConfig();
      const rec = recommendRoute({
        requestedModel: model,
        windowUtilization,
        enabledProviders: deps.enabledProviders(),
        hotThresholdPct,
        autoRoute,
        providerForModel: (m) => resolveModel(m)?.provider ?? 'claude',
        coolestModelForProvider: (p) => `${p}-default`,
      });
      res.json(rec);
    } catch (err) {
      logger.error({ err }, 'Failed to compute routing recommendation');
      res.status(500).json({ error: 'Failed to compute routing recommendation' });
    }
  });

  return router;
}
