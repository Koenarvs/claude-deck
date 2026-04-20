#!/usr/bin/env tsx
/**
 * CLI script to install claude-deck hooks into ~/.claude/settings.json.
 *
 * Usage:
 *   npx tsx scripts/install-hooks.ts
 *
 * Behavior:
 * - Backs up existing settings.json with timestamp
 * - Merges claude-deck hooks (preserves other tools' hooks)
 * - Idempotent: safe to run multiple times
 *
 * Exit codes:
 *   0 — success (installed or already installed)
 *   1 — error
 */

import { HookInstallerService } from '../server/services/hook-installer-service';

async function main(): Promise<void> {
  const service = new HookInstallerService();

  console.log('claude-deck: Installing hooks into ~/.claude/settings.json ...');

  try {
    const result = await service.install();

    if (result.backupPath) {
      console.log(`  Backup created: ${result.backupPath}`);
    } else {
      console.log('  Hooks already installed (idempotent no-op).');
    }

    console.log('  Hooks installed successfully.');

    const status = await service.status();
    if (status.installedAt) {
      console.log(`  Installed at: ${new Date(status.installedAt).toISOString()}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Error: ${message}`);
    process.exit(1);
  }
}

main();
