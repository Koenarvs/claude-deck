#!/usr/bin/env tsx
/**
 * CLI script to uninstall claude-deck hooks from ~/.claude/settings.json.
 *
 * Usage:
 *   npx tsx scripts/uninstall-hooks.ts
 *
 * Behavior:
 * - Restores settings.json from the backup taken during install
 * - Removes the install marker file
 * - Idempotent: safe to run when not installed
 *
 * Exit codes:
 *   0 — success (uninstalled or was not installed)
 *   1 — error
 */

import { HookInstallerService } from '../server/services/hook-installer-service';

async function main(): Promise<void> {
  const service = new HookInstallerService();

  console.log('claude-deck: Uninstalling hooks from ~/.claude/settings.json ...');

  try {
    const result = await service.uninstall();

    if (result.uninstalled) {
      console.log('  Hooks uninstalled successfully. Original settings restored.');
    } else {
      console.log('  Hooks were not installed. Nothing to do.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Error: ${message}`);
    process.exit(1);
  }
}

main();
