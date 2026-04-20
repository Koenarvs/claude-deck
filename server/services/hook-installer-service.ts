import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import logger from '../logger';

// ── Types ────────────────────────────────────────────────────────────────────

/** A single hook command entry within a hook event type. */
interface HookCommand {
  type: 'command';
  command: string;
}

/** A hook matcher entry (array element under a hook event type key). */
interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

/** The `hooks` object inside settings.json. */
interface HooksObject {
  [eventType: string]: HookMatcher[];
}

/** The full settings.json structure (partial — we only care about `hooks`). */
interface SettingsJson {
  hooks?: HooksObject;
  [key: string]: unknown;
}

/** Marker file content. */
interface InstallMarker {
  installedAt: number;
  backupPath: string;
  hookClientPath: string;
}

/** Result of an install operation. */
export interface InstallResult {
  installed: boolean;
  backupPath: string | null;
}

/** Result of an uninstall operation. */
export interface UninstallResult {
  uninstalled: boolean;
}

/** Result of a status check. */
export interface InstallStatus {
  installed: boolean;
  installedAt: number | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const SETTINGS_FILENAME = 'settings.json';
const CLAUDE_DIR_NAME = '.claude';
const MARKER_FILENAME = '.claude-deck-install-marker.json';

/** The hook event types claude-deck registers for. */
const HOOK_EVENT_TYPES: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
] as const;

/** Sentinel substring used to identify claude-deck hook commands. */
const HOOK_SENTINEL = 'hooks/client.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalizes a file path to use forward slashes (Windows-compatible for node).
 * Per spec section 16.1, hook commands use forward slashes.
 */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Resolves the path to ~/.claude/ directory.
 * Creates it if it does not exist.
 */
function resolveClaudeDir(homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  const claudeDir = path.join(home, CLAUDE_DIR_NAME);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  return claudeDir;
}

/**
 * Resolves the settings.json path inside ~/.claude/.
 */
function resolveSettingsPath(homeDir?: string): string {
  return path.join(resolveClaudeDir(homeDir), SETTINGS_FILENAME);
}

/**
 * Resolves the marker file path inside ~/.claude/.
 */
function resolveMarkerPath(homeDir?: string): string {
  return path.join(resolveClaudeDir(homeDir), MARKER_FILENAME);
}

/**
 * Reads and parses settings.json. Returns empty object if file does not exist.
 * Throws on malformed JSON.
 */
function readSettings(settingsPath: string): SettingsJson {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings.json is not a JSON object');
  }
  return parsed as SettingsJson;
}

/**
 * Writes settings.json atomically (write temp, then rename).
 */
function writeSettingsAtomic(settingsPath: string, settings: SettingsJson): void {
  const dir = path.dirname(settingsPath);
  const tmpPath = path.join(dir, `.settings-${randomUUID()}.tmp`);
  const content = JSON.stringify(settings, null, 2) + '\n';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, settingsPath);
}

/**
 * Validates that a parsed object looks like a valid settings.json.
 * Basic structural check: must be a non-array object.
 */
function validateSettingsStructure(obj: unknown): obj is SettingsJson {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}

/**
 * Resolves the absolute path to hooks/client.js.
 *
 * Strategy (per spec section 16.1):
 * 1. If repo root path has no spaces, use `<repoRoot>/hooks/client.js`
 * 2. Otherwise, fall back to `~/.claude-deck/hooks/client.js`
 *
 * @param repoRoot - Absolute path to the claude-deck repo root
 * @param homeDir - Override home directory (for testing)
 */
function resolveHookClientPath(repoRoot?: string, homeDir?: string): string {
  const root = repoRoot ?? findRepoRoot();
  const candidatePath = path.join(root, 'hooks', 'client.js');

  if (!root.includes(' ')) {
    return toForwardSlash(candidatePath);
  }

  // Fallback: ~/.claude-deck/hooks/client.js
  const home = homeDir ?? os.homedir();
  const fallbackPath = path.join(home, '.claude-deck', 'hooks', 'client.js');
  return toForwardSlash(fallbackPath);
}

/**
 * Finds the repo root by walking up from this file's location.
 * Falls back to cwd if package.json is not found.
 */
function findRepoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  // On Windows, URL pathname starts with /C:/ — strip leading slash
  if (process.platform === 'win32' && dir.startsWith('/')) {
    dir = dir.slice(1);
  }
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Converts a PascalCase event type to kebab-case for the CLI argument.
 * e.g., "PreToolUse" -> "pre-tool-use"
 */
function toKebabCase(eventType: string): string {
  return eventType.replace(/([A-Z])/g, (_, c: string, i: number) => (i > 0 ? '-' : '') + c.toLowerCase());
}

/**
 * Checks whether a hook command belongs to claude-deck.
 */
function isClaudeDeckHook(command: string): boolean {
  return command.includes(HOOK_SENTINEL);
}

/**
 * Builds the HookMatcher entry that claude-deck installs for a given event type.
 */
function buildHookMatcher(hookClientPath: string, eventType: string): HookMatcher {
  const kebab = toKebabCase(eventType);
  return {
    hooks: [
      {
        type: 'command',
        command: `node "${hookClientPath}" ${kebab}`,
      },
    ],
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Hook installer service. Manages the lifecycle of claude-deck hooks
 * in `~/.claude/settings.json`.
 *
 * Thread-safe for single-process use (no concurrent modifications).
 */
export class HookInstallerService {
  private readonly homeDir: string | undefined;
  private readonly repoRoot: string | undefined;

  /**
   * Creates a HookInstallerService.
   *
   * @param options.homeDir - Override the home directory (for testing)
   * @param options.repoRoot - Override the repo root (for testing)
   */
  constructor(options?: { homeDir?: string; repoRoot?: string }) {
    this.homeDir = options?.homeDir;
    this.repoRoot = options?.repoRoot;
  }

  /**
   * Installs claude-deck hooks into ~/.claude/settings.json.
   *
   * Behavior:
   * 1. Creates ~/.claude/ if missing.
   * 2. Backs up existing settings.json with timestamp.
   * 3. Merges claude-deck hooks into existing hooks (preserves other tools' hooks).
   * 4. Writes settings.json atomically (temp + rename).
   * 5. Creates install marker file.
   *
   * Idempotent: running twice is a no-op (returns installed: true, backupPath: null).
   *
   * @returns Install result with backup path (null if already installed)
   */
  async install(): Promise<InstallResult> {
    const markerPath = resolveMarkerPath(this.homeDir);

    // Idempotency check
    if (fs.existsSync(markerPath)) {
      logger.info('claude-deck hooks already installed (marker found). Skipping.');
      return { installed: true, backupPath: null };
    }

    const settingsPath = resolveSettingsPath(this.homeDir);
    const hookClientPath = resolveHookClientPath(this.repoRoot, this.homeDir);

    // Read existing settings (or empty object if no file)
    let settings: SettingsJson;
    try {
      settings = readSettings(settingsPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read settings.json: ${msg}`);
    }

    // Create timestamped backup if settings.json exists
    let backupPath: string | null = null;
    if (fs.existsSync(settingsPath)) {
      const timestamp = Date.now();
      backupPath = path.join(
        resolveClaudeDir(this.homeDir),
        `settings.claude-deck-backup-${timestamp}.json`,
      );
      fs.copyFileSync(settingsPath, backupPath);
      logger.info({ backupPath }, 'Backed up settings.json');
    }

    // Merge hooks
    const existingHooks: HooksObject = (settings.hooks as HooksObject) ?? {};
    const mergedHooks = this.mergeHooks(existingHooks, hookClientPath);

    settings.hooks = mergedHooks;

    // Write atomically
    writeSettingsAtomic(settingsPath, settings);
    logger.info({ settingsPath }, 'Wrote updated settings.json');

    // Write marker
    const marker: InstallMarker = {
      installedAt: Date.now(),
      backupPath: backupPath ?? '',
      hookClientPath,
    };
    fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n', 'utf-8');
    logger.info({ markerPath }, 'Wrote install marker');

    return { installed: true, backupPath };
  }

  /**
   * Uninstalls claude-deck hooks by restoring the backup from settings.json.
   *
   * Behavior:
   * 1. Reads the install marker to find the backup file.
   * 2. If a backup exists and is valid JSON, restores it (byte-for-byte copy).
   * 3. If no backup was taken (fresh install on empty settings), removes our hooks from settings.json.
   * 4. Removes the marker file.
   *
   * Idempotent: running uninstall when not installed is a no-op.
   *
   * @returns Uninstall result
   */
  async uninstall(): Promise<UninstallResult> {
    const markerPath = resolveMarkerPath(this.homeDir);

    if (!fs.existsSync(markerPath)) {
      logger.info('claude-deck hooks not installed (no marker). Nothing to uninstall.');
      return { uninstalled: false };
    }

    const markerRaw = fs.readFileSync(markerPath, 'utf-8');
    let marker: InstallMarker;
    try {
      marker = JSON.parse(markerRaw) as InstallMarker;
    } catch {
      throw new Error('Install marker file is corrupted');
    }

    const settingsPath = resolveSettingsPath(this.homeDir);

    if (marker.backupPath && fs.existsSync(marker.backupPath)) {
      // Validate backup is valid JSON before restoring
      const backupRaw = fs.readFileSync(marker.backupPath, 'utf-8');
      const parsed: unknown = JSON.parse(backupRaw);
      if (!validateSettingsStructure(parsed)) {
        throw new Error('Backup file is not valid JSON object');
      }

      // Restore byte-for-byte from backup
      fs.copyFileSync(marker.backupPath, settingsPath);
      logger.info({ backupPath: marker.backupPath }, 'Restored settings.json from backup');

      // Clean up backup file
      fs.unlinkSync(marker.backupPath);
    } else {
      // No backup means we created settings.json from scratch.
      // Remove our hooks from the current settings.
      try {
        const settings = readSettings(settingsPath);
        if (settings.hooks) {
          settings.hooks = this.removeOurHooks(settings.hooks as HooksObject);
          // If hooks object is now empty, remove the key entirely
          if (Object.keys(settings.hooks).length === 0) {
            delete settings.hooks;
          }
          writeSettingsAtomic(settingsPath, settings);
        }
      } catch {
        // If we can't clean up gracefully, still remove the marker
        logger.warn('Could not clean hooks from settings.json during uninstall');
      }
    }

    // Remove marker
    fs.unlinkSync(markerPath);
    logger.info('Removed install marker');

    return { uninstalled: true };
  }

  /**
   * Returns the current installation status.
   *
   * @returns Whether hooks are installed and when they were installed
   */
  async status(): Promise<InstallStatus> {
    const markerPath = resolveMarkerPath(this.homeDir);

    if (!fs.existsSync(markerPath)) {
      return { installed: false, installedAt: null };
    }

    try {
      const markerRaw = fs.readFileSync(markerPath, 'utf-8');
      const marker = JSON.parse(markerRaw) as InstallMarker;
      return { installed: true, installedAt: marker.installedAt };
    } catch {
      return { installed: false, installedAt: null };
    }
  }

  /**
   * Merges claude-deck hooks into an existing hooks object.
   * Preserves all pre-existing hooks from other tools.
   * Does not duplicate if our hooks are already present.
   *
   * @param existing - The current hooks object from settings.json
   * @param hookClientPath - Absolute path to hooks/client.js
   * @returns Merged hooks object
   */
  mergeHooks(existing: HooksObject, hookClientPath: string): HooksObject {
    const merged: HooksObject = { ...existing };

    for (const eventType of HOOK_EVENT_TYPES) {
      const ourMatcher = buildHookMatcher(hookClientPath, eventType);
      const existingMatchers = merged[eventType] ?? [];

      // Check if we already have a claude-deck hook in this event type
      const alreadyHasOurs = existingMatchers.some((matcher) =>
        matcher.hooks.some((h) => isClaudeDeckHook(h.command)),
      );

      if (alreadyHasOurs) {
        // Already installed for this event type — skip
        continue;
      }

      // Append our matcher to the existing list
      merged[eventType] = [...existingMatchers, ourMatcher];
    }

    return merged;
  }

  /**
   * Removes all claude-deck hooks from a hooks object.
   * Preserves hooks from other tools.
   *
   * @param hooks - The current hooks object
   * @returns Hooks object with claude-deck hooks removed
   */
  removeOurHooks(hooks: HooksObject): HooksObject {
    const cleaned: HooksObject = {};

    for (const [eventType, matchers] of Object.entries(hooks)) {
      const filtered = matchers.filter(
        (matcher) => !matcher.hooks.some((h) => isClaudeDeckHook(h.command)),
      );
      if (filtered.length > 0) {
        cleaned[eventType] = filtered;
      }
    }

    return cleaned;
  }
}

/**
 * Default singleton instance for use in routes and CLI scripts.
 */
export const hookInstallerService = new HookInstallerService();
