import { Router } from 'express';
import { hookInstallerService } from '../services/hook-installer-service';
import logger from '../logger';

const router = Router();

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

export default router;
