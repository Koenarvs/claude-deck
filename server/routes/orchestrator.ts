import { Router } from 'express';
import { ZodError } from 'zod';
import {
  PostOwnerMessageSchema,
  UpdateOrchestratorConfigSchema,
  type OrchestratorTrigger,
} from '../../src/shared/orchestrator';
import { ApprovalDecisionSchema } from '../../src/shared/schemas';
import type { OrchestratorStateService } from '../services/orchestrator-state-service';
import type { OrchestratorMessageService } from '../services/orchestrator-message-service';
import logger from '../logger';

export interface OrchestratorRouterDeps {
  stateService: OrchestratorStateService;
  messageService: OrchestratorMessageService;
  trigger: (t: OrchestratorTrigger) => Promise<void>;
  /** Resolves an approval through the ApprovalCoordinator. Returns false if stale. */
  ratifyApproval: (approvalId: string, decision: 'approved' | 'denied', reason?: string) => boolean;
}

const MESSAGE_PAGE = 200;

/** REST API for the orchestrator (thread, owner messages, config, ratify decisions). */
export function createOrchestratorRouter(deps: OrchestratorRouterDeps): Router {
  const router = Router();

  router.get('/orchestrator', (_req, res) => {
    res.json({
      state: deps.stateService.get(),
      messages: deps.messageService.list(MESSAGE_PAGE),
    });
  });

  router.post('/orchestrator/messages', (req, res) => {
    const parsed = PostOwnerMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid message', issues: parsed.error.issues });
      return;
    }
    void deps.trigger({
      kind: 'owner_message',
      text: parsed.data.text,
      channel: parsed.data.channel ?? 'app',
    });
    res.status(202).json({ accepted: true });
  });

  router.put('/orchestrator/config', (req, res) => {
    const parsed = UpdateOrchestratorConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid config', issues: parsed.error.issues });
      return;
    }
    try {
      res.json(deps.stateService.updateConfig(parsed.data));
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: 'Invalid config', issues: err.issues });
        return;
      }
      throw err;
    }
  });

  router.post('/orchestrator/decision', (req, res) => {
    const body = req.body as { approvalId?: unknown; decision?: unknown; reason?: unknown };
    if (typeof body.approvalId !== 'string') {
      res.status(400).json({ error: 'approvalId required' });
      return;
    }
    const decision = ApprovalDecisionSchema.safeParse(body.decision);
    if (!decision.success || (decision.data !== 'approved' && decision.data !== 'denied')) {
      res.status(400).json({ error: 'decision must be approved or denied' });
      return;
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const ok = deps.ratifyApproval(body.approvalId, decision.data, reason);
    if (!ok) {
      res.status(409).json({ error: 'approval not pending (stale or already resolved)' });
      return;
    }
    logger.info({ approvalId: body.approvalId, decision: decision.data }, 'Orchestrator decision ratified');
    res.json({ ok: true });
  });

  return router;
}
