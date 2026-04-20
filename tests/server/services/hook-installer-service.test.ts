import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HookInstallerService } from '../../../server/services/hook-installer-service';

/**
 * Creates a temporary directory that simulates a user's home directory.
 * Returns { homeDir, claudeDir, settingsPath, markerPath, cleanup }.
 */
function createTempHome(): {
  homeDir: string;
  claudeDir: string;
  settingsPath: string;
  markerPath: string;
  repoRoot: string;
  cleanup: () => void;
} {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-deck-test-'));
  const claudeDir = path.join(homeDir, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const markerPath = path.join(claudeDir, '.claude-deck-install-marker.json');
  // Use a repo root without spaces for most tests
  const repoRoot = path.join(homeDir, 'claude-deck');
  fs.mkdirSync(repoRoot, { recursive: true });
  // Create a package.json so findRepoRoot can locate it
  fs.writeFileSync(path.join(repoRoot, 'package.json'), '{}');

  return {
    homeDir,
    claudeDir,
    settingsPath,
    markerPath,
    repoRoot,
    cleanup: () => {
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

describe('HookInstallerService', () => {
  let env: ReturnType<typeof createTempHome>;
  let service: HookInstallerService;

  beforeEach(() => {
    env = createTempHome();
    service = new HookInstallerService({
      homeDir: env.homeDir,
      repoRoot: env.repoRoot,
    });
  });

  afterEach(() => {
    env.cleanup();
  });

  // ── QA-1: Fresh user — no settings.json ──────────────────────────────────

  describe('QA-1: Fresh user (no ~/.claude/settings.json)', () => {
    it('creates settings.json with claude-deck hooks', async () => {
      const result = await service.install();

      expect(result.installed).toBe(true);
      expect(result.backupPath).toBeNull(); // No file to back up
      expect(fs.existsSync(env.settingsPath)).toBe(true);

      const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
    });

    it('each hook event type has exactly one matcher with one command', async () => {
      await service.install();
      const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));

      for (const eventType of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
        const matchers = settings.hooks[eventType];
        expect(matchers).toHaveLength(1);
        expect(matchers[0].hooks).toHaveLength(1);
        expect(matchers[0].hooks[0].type).toBe('command');
        expect(matchers[0].hooks[0].command).toContain('hooks/client.js');
      }
    });

    it('hook commands use forward slashes', async () => {
      await service.install();
      const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));

      for (const eventType of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
        const command: string = settings.hooks[eventType][0].hooks[0].command;
        // No backslashes in the path portion
        expect(command).not.toMatch(/\\/);
      }
    });

    it('hook commands contain correct kebab-case event names', async () => {
      await service.install();
      const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));

      expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('session-start');
      expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('user-prompt-submit');
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('pre-tool-use');
      expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain('post-tool-use');
      expect(settings.hooks.Stop[0].hooks[0].command).toContain('stop');
    });

    it('creates install marker file', async () => {
      await service.install();

      expect(fs.existsSync(env.markerPath)).toBe(true);
      const marker = JSON.parse(fs.readFileSync(env.markerPath, 'utf-8'));
      expect(marker.installedAt).toBeTypeOf('number');
      expect(marker.hookClientPath).toContain('hooks/client.js');
    });
  });

  // ── QA-2: User with existing hooks ───────────────────────────────────────

  describe('QA-2: User with existing hooks', () => {
    it('preserves existing hooks and appends ours', async () => {
      // Set up existing settings.json with another tool's hooks
      fs.mkdirSync(env.claudeDir, { recursive: true });
      const existingSettings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command: 'node /some/other/tool/hook.js pre-tool-use',
                },
              ],
            },
          ],
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node /another/tool/hook.js session-start',
                },
              ],
            },
          ],
        },
        someOtherSetting: 'preserved',
      };
      fs.writeFileSync(env.settingsPath, JSON.stringify(existingSettings, null, 2));

      const result = await service.install();

      expect(result.installed).toBe(true);
      expect(result.backupPath).toBeTruthy();

      const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));

      // Existing PreToolUse hook should still be there
      expect(settings.hooks.PreToolUse).toHaveLength(2);
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('/some/other/tool/hook.js');
      expect(settings.hooks.PreToolUse[1].hooks[0].command).toContain('hooks/client.js');

      // Existing SessionStart hook should still be there
      expect(settings.hooks.SessionStart).toHaveLength(2);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toContain('/another/tool/hook.js');

      // Other settings preserved
      expect(settings.someOtherSetting).toBe('preserved');

      // All 5 event types should have our hooks
      for (const eventType of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
        const hasOurs = settings.hooks[eventType].some((m: { hooks: { command: string }[] }) =>
          m.hooks.some((h: { command: string }) => h.command.includes('hooks/client.js')),
        );
        expect(hasOurs, `Expected ${eventType} to have claude-deck hook`).toBe(true);
      }
    });

    it('creates a backup file', async () => {
      fs.mkdirSync(env.claudeDir, { recursive: true });
      const originalContent = JSON.stringify({ existingKey: 'value' }, null, 2);
      fs.writeFileSync(env.settingsPath, originalContent);

      const result = await service.install();

      expect(result.backupPath).toBeTruthy();
      expect(fs.existsSync(result.backupPath!)).toBe(true);
      const backupContent = fs.readFileSync(result.backupPath!, 'utf-8');
      expect(backupContent).toBe(originalContent);
    });
  });

  // ── QA-3: Install twice — idempotent ─────────────────────────────────────

  describe('QA-3: Install twice — idempotent', () => {
    it('second install is a no-op; hooks not duplicated', async () => {
      // First install
      const result1 = await service.install();
      expect(result1.installed).toBe(true);

      const afterFirst = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));

      // Second install
      const result2 = await service.install();
      expect(result2.installed).toBe(true);
      expect(result2.backupPath).toBeNull(); // No new backup on second run

      const afterSecond = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));

      // Settings unchanged
      expect(afterSecond).toEqual(afterFirst);

      // Each event type should have exactly one matcher
      for (const eventType of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
        expect(afterSecond.hooks[eventType]).toHaveLength(1);
      }
    });
  });

  // ── QA-4: Uninstall after install ────────────────────────────────────────

  describe('QA-4: Uninstall after install — byte-for-byte restore', () => {
    it('restores pre-install backup byte-for-byte', async () => {
      // Create initial settings
      fs.mkdirSync(env.claudeDir, { recursive: true });
      const originalContent = JSON.stringify({ hooks: {}, myConfig: true }, null, 2);
      fs.writeFileSync(env.settingsPath, originalContent);

      // Install
      await service.install();
      expect(fs.existsSync(env.markerPath)).toBe(true);

      // Verify settings changed
      const afterInstall = fs.readFileSync(env.settingsPath, 'utf-8');
      expect(afterInstall).not.toBe(originalContent);

      // Uninstall
      const result = await service.uninstall();
      expect(result.uninstalled).toBe(true);

      // Verify restored
      const afterUninstall = fs.readFileSync(env.settingsPath, 'utf-8');
      expect(afterUninstall).toBe(originalContent);

      // Marker removed
      expect(fs.existsSync(env.markerPath)).toBe(false);
    });

    it('uninstall on fresh install (no prior settings.json) removes hooks cleanly', async () => {
      // Install fresh (no existing settings.json)
      await service.install();

      // Uninstall
      const result = await service.uninstall();
      expect(result.uninstalled).toBe(true);

      // Settings should exist but have no hooks (or be empty)
      const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));
      expect(settings.hooks).toBeUndefined();

      // Marker removed
      expect(fs.existsSync(env.markerPath)).toBe(false);
    });
  });

  // ── QA-5: Uninstall without prior install ────────────────────────────────

  describe('QA-5: Uninstall without prior install', () => {
    it('returns uninstalled: false and does not error', async () => {
      const result = await service.uninstall();
      expect(result.uninstalled).toBe(false);
    });

    it('does not modify settings.json if it exists', async () => {
      fs.mkdirSync(env.claudeDir, { recursive: true });
      const original = JSON.stringify({ untouched: true });
      fs.writeFileSync(env.settingsPath, original);

      await service.uninstall();

      const content = fs.readFileSync(env.settingsPath, 'utf-8');
      expect(content).toBe(original);
    });
  });

  // ── QA-6: Install from path with spaces ──────────────────────────────────

  describe('QA-6: Install from path with spaces', () => {
    it('uses fallback ~/.claude-deck/ location when repo root has spaces', async () => {
      const spacyRoot = path.join(env.homeDir, 'path with spaces', 'claude-deck');
      fs.mkdirSync(spacyRoot, { recursive: true });
      fs.writeFileSync(path.join(spacyRoot, 'package.json'), '{}');

      const spacyService = new HookInstallerService({
        homeDir: env.homeDir,
        repoRoot: spacyRoot,
      });

      await spacyService.install();

      const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf-8'));
      const command: string = settings.hooks.PreToolUse[0].hooks[0].command;

      // Should use the fallback path under home dir
      expect(command).toContain('.claude-deck/hooks/client.js');
      // Forward slashes only
      expect(command).not.toMatch(/\\/);
    });
  });

  // ── Status ───────────────────────────────────────────────────────────────

  describe('status()', () => {
    it('returns installed: false when not installed', async () => {
      const status = await service.status();
      expect(status.installed).toBe(false);
      expect(status.installedAt).toBeNull();
    });

    it('returns installed: true with timestamp after install', async () => {
      const before = Date.now();
      await service.install();
      const after = Date.now();

      const status = await service.status();
      expect(status.installed).toBe(true);
      expect(status.installedAt).toBeTypeOf('number');
      expect(status.installedAt!).toBeGreaterThanOrEqual(before);
      expect(status.installedAt!).toBeLessThanOrEqual(after);
    });

    it('returns installed: false after uninstall', async () => {
      await service.install();
      await service.uninstall();

      const status = await service.status();
      expect(status.installed).toBe(false);
      expect(status.installedAt).toBeNull();
    });
  });

  // ── mergeHooks (unit tests for the merge logic) ──────────────────────────

  describe('mergeHooks()', () => {
    const hookClientPath = '/test/hooks/client.js';

    it('creates all 5 event types from empty hooks object', () => {
      const result = service.mergeHooks({}, hookClientPath);

      expect(Object.keys(result)).toHaveLength(5);
      expect(result.SessionStart).toHaveLength(1);
      expect(result.UserPromptSubmit).toHaveLength(1);
      expect(result.PreToolUse).toHaveLength(1);
      expect(result.PostToolUse).toHaveLength(1);
      expect(result.Stop).toHaveLength(1);
    });

    it('appends to existing matchers without replacing', () => {
      const existing = {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command' as const, command: 'echo pre-tool-use' }],
          },
        ],
      };

      const result = service.mergeHooks(existing, hookClientPath);

      // Original matcher preserved + ours appended
      expect(result.PreToolUse).toHaveLength(2);
      expect(result.PreToolUse[0].matcher).toBe('Bash');
      expect(result.PreToolUse[0].hooks[0].command).toBe('echo pre-tool-use');
      expect(result.PreToolUse[1].hooks[0].command).toContain('hooks/client.js');
    });

    it('does not duplicate if our hooks are already present', () => {
      const existing = {
        PreToolUse: [
          {
            hooks: [{ type: 'command' as const, command: `node "${hookClientPath}" pre-tool-use` }],
          },
        ],
      };

      const result = service.mergeHooks(existing, hookClientPath);

      expect(result.PreToolUse).toHaveLength(1);
    });

    it('preserves unknown event types', () => {
      const existing = {
        SomeCustomEvent: [
          {
            hooks: [{ type: 'command' as const, command: 'echo custom' }],
          },
        ],
      };

      const result = service.mergeHooks(existing, hookClientPath);

      expect(result.SomeCustomEvent).toBeDefined();
      expect(result.SomeCustomEvent).toHaveLength(1);
    });
  });

  // ── removeOurHooks ───────────────────────────────────────────────────────

  describe('removeOurHooks()', () => {
    it('removes only claude-deck hooks', () => {
      const hooks = {
        PreToolUse: [
          { hooks: [{ type: 'command' as const, command: 'echo other' }] },
          { hooks: [{ type: 'command' as const, command: 'node "/test/hooks/client.js" pre-tool-use' }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command' as const, command: 'node "/test/hooks/client.js" session-start' }] },
        ],
      };

      const result = service.removeOurHooks(hooks);

      // PreToolUse should keep the non-claude-deck hook
      expect(result.PreToolUse).toHaveLength(1);
      expect(result.PreToolUse[0].hooks[0].command).toBe('echo other');

      // SessionStart had only our hook, so it should be removed entirely
      expect(result.SessionStart).toBeUndefined();
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws on malformed settings.json', async () => {
      fs.mkdirSync(env.claudeDir, { recursive: true });
      fs.writeFileSync(env.settingsPath, 'this is not json');

      await expect(service.install()).rejects.toThrow();
    });

    it('throws on settings.json that is a JSON array', async () => {
      fs.mkdirSync(env.claudeDir, { recursive: true });
      fs.writeFileSync(env.settingsPath, '[1, 2, 3]');

      await expect(service.install()).rejects.toThrow('not a JSON object');
    });
  });

  // ── Atomic write verification ────────────────────────────────────────────

  describe('atomic writes', () => {
    it('does not leave temp files on successful install', async () => {
      await service.install();

      const claudeDir = path.join(env.homeDir, '.claude');
      const files = fs.readdirSync(claudeDir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});
