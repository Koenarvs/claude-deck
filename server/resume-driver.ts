import type { Orphan } from './services/reconciliation-service';
import logger from './logger';

export interface ResumeDeps {
  /** True if the provider for this model can resume (adapter.capabilities.canResume). */
  canResume: (model: string | null) => boolean;
  /** Actually resume the orphan (spawn PTY with --resume / buildResumeArgs). */
  resume: (orphan: Orphan) => void;
}

/**
 * Resume-on-boot driver (5D). For each orphan with a resumable provider and a
 * stored provider session id, invokes deps.resume. Pure orchestration —
 * adapter selection + PTY spawn are injected so this is unit-testable.
 */
export function resumeOrphans(orphans: Orphan[], deps: ResumeDeps): void {
  for (const o of orphans) {
    if (!o.providerSessionId) {
      logger.warn({ goalId: o.goalId }, 'resume: no provider session id — skipping');
      continue;
    }
    if (!deps.canResume(o.model)) {
      logger.info({ goalId: o.goalId, model: o.model }, 'resume: provider cannot resume — skipping');
      continue;
    }
    try {
      deps.resume(o);
      logger.info({ goalId: o.goalId }, 'resume: orphan resumed on boot');
    } catch (err) {
      logger.error({ err, goalId: o.goalId }, 'resume: failed to resume orphan');
    }
  }
}
