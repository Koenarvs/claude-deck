import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../middleware/validate';
import type { SkillExecutionService } from '../services/skill-execution-service';
import type { SkillAnalysisService } from '../services/skill-analysis-service';
import type { SkillFileService } from '../services/skill-file-service';
import { StaleContentError } from '../services/skill-file-service';
import { scanSkills } from '../skill-scanner';
import logger from '../logger';

// ── Schemas ─────────────────────────────────────────────────────────────────

const RateExecutionSchema = z.object({
  rating: z.number().int().min(1).max(5),
  notes: z.string().optional(),
});

// ── Route Factory ───────────────────────────────────────────────────────────

export function createSkillsRouter(
  executionService: SkillExecutionService,
  analysisService: SkillAnalysisService,
  fileService: SkillFileService,
): Router {
  const router = Router();

  // GET /skills/:name/metrics — aggregated performance metrics
  router.get('/skills/:name/metrics', (req: Request, res: Response) => {
    try {
      const metrics = executionService.getSkillMetrics(req.params.name);
      res.json(metrics);
    } catch (err) {
      logger.error({ err, skill: req.params.name }, 'Failed to get skill metrics');
      res.status(500).json({ error: 'Failed to get metrics' });
    }
  });

  // GET /skills/:name/executions — execution history
  router.get('/skills/:name/executions', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const executions = executionService.getExecutionHistory(req.params.name, limit);
      res.json(executions);
    } catch (err) {
      logger.error({ err, skill: req.params.name }, 'Failed to get execution history');
      res.status(500).json({ error: 'Failed to get execution history' });
    }
  });

  // POST /skills/executions/:id/rate — rate an execution
  router.post(
    '/skills/executions/:id/rate',
    validateBody(RateExecutionSchema),
    (req: Request, res: Response) => {
      try {
        const execution = executionService.rateExecution(
          req.params.id,
          req.body.rating,
          req.body.notes ?? null,
        );
        if (!execution) {
          res.status(404).json({ error: 'Execution not found' });
          return;
        }
        res.json(execution);
      } catch (err) {
        logger.error({ err, id: req.params.id }, 'Failed to rate execution');
        res.status(500).json({ error: 'Failed to rate execution' });
      }
    },
  );

  // POST /skills/:name/analyze — trigger analysis
  router.post('/skills/:name/analyze', async (req: Request, res: Response) => {
    try {
      const skillName = req.params.name;
      const skills = scanSkills({ includeContent: false });
      const skill = skills.find((s) => s.name === skillName);

      if (!skill) {
        res.status(404).json({ error: `Skill not found: ${skillName}` });
        return;
      }

      const executions = executionService.getExecutionHistory(skillName, 10);
      const suggestions = await analysisService.analyzeSkill(skillName, skill.path, executions);
      res.json(suggestions);
    } catch (err) {
      logger.error({ err, skill: req.params.name }, 'Skill analysis failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Analysis failed' });
    }
  });

  // GET /skills/:name/suggestions — list pending suggestions
  router.get('/skills/:name/suggestions', (req: Request, res: Response) => {
    try {
      const suggestions = analysisService.getSuggestions(req.params.name);
      res.json(suggestions);
    } catch (err) {
      logger.error({ err, skill: req.params.name }, 'Failed to get suggestions');
      res.status(500).json({ error: 'Failed to get suggestions' });
    }
  });

  // POST /skills/suggestions/:id/apply — apply a suggestion
  router.post('/skills/suggestions/:id/apply', (req: Request, res: Response) => {
    try {
      const suggestion = analysisService.getSuggestion(req.params.id);
      if (!suggestion) {
        res.status(404).json({ error: 'Suggestion not found' });
        return;
      }
      if (suggestion.status !== 'pending') {
        res.status(400).json({ error: `Suggestion already ${suggestion.status}` });
        return;
      }
      if (!suggestion.skill_path) {
        res.status(400).json({ error: 'Suggestion has no skill path' });
        return;
      }

      const { version } = fileService.applySuggestion(
        suggestion.skill_path,
        suggestion.skill_name,
        suggestion.diff_content,
        `Applied suggestion: ${suggestion.title}`,
        suggestion.content_hash,
      );

      analysisService.markApplied(suggestion.id);

      res.json({
        message: 'Suggestion applied',
        suggestion_id: suggestion.id,
        version_id: version.id,
        version_number: version.version_number,
      });
    } catch (err) {
      if (err instanceof StaleContentError) {
        res.status(409).json({ error: err.message });
        return;
      }
      logger.error({ err, id: req.params.id }, 'Failed to apply suggestion');
      res.status(500).json({ error: 'Failed to apply suggestion' });
    }
  });

  // POST /skills/suggestions/:id/dismiss — dismiss a suggestion
  router.post('/skills/suggestions/:id/dismiss', (req: Request, res: Response) => {
    try {
      const suggestion = analysisService.dismissSuggestion(req.params.id);
      if (!suggestion) {
        res.status(404).json({ error: 'Suggestion not found' });
        return;
      }
      res.json(suggestion);
    } catch (err) {
      logger.error({ err, id: req.params.id }, 'Failed to dismiss suggestion');
      res.status(500).json({ error: 'Failed to dismiss suggestion' });
    }
  });

  // GET /skills/:name/versions — version history
  router.get('/skills/:name/versions', (req: Request, res: Response) => {
    try {
      const versions = fileService.getVersionHistory(req.params.name);
      res.json(versions);
    } catch (err) {
      logger.error({ err, skill: req.params.name }, 'Failed to get version history');
      res.status(500).json({ error: 'Failed to get version history' });
    }
  });

  // POST /skills/versions/:id/revert — revert to a version
  router.post('/skills/versions/:id/revert', (req: Request, res: Response) => {
    try {
      const { version } = fileService.revertToVersion(req.params.id);
      res.json({
        message: 'Reverted successfully',
        version_id: version.id,
        version_number: version.version_number,
      });
    } catch (err) {
      logger.error({ err, id: req.params.id }, 'Failed to revert version');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to revert' });
    }
  });

  return router;
}
