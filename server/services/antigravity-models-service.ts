import * as pty from 'node-pty';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelOption } from '../../src/shared/agents/types';
import logger from '../logger';

/**
 * Fetches Antigravity's live model list — the exact set its own picker shows (Gemini
 * 3.x, Claude, GPT-OSS, with effort levels) — by running `agy models`. That command
 * only renders to a TTY (a pipe yields nothing), so it is run through a PTY (node-pty,
 * already a project dependency) and its output parsed. The selectable strings ARE the
 * model identifiers (Antigravity selects by display name), so value === label.
 *
 * `agy models` performs a network fetch (~seconds), so this service is NON-BLOCKING:
 * getModelOptions() returns the cached list immediately (or null on a cold cache) and
 * refreshes in the background. Call warm() once at server boot so the cache is ready
 * before the UI loads. Returns null → callers fall back to the static registry list.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_TIMEOUT_MS = 25_000; // agy models ~9s; generous ceiling before fallback

/** The subset of node-pty's IPty the service uses (injectable for tests). */
export interface PtyProc {
  onData(cb: (d: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

export interface AntigravityModelsDeps {
  resolveBinary?: () => string;
  spawnPty?: (file: string, args: string[]) => PtyProc;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

/**
 * Parses `agy models` TTY output into options. Strips ANSI/OSC escapes, the braille
 * spinner glyphs, the "Fetching available models..." progress text, and stray control
 * chars; each remaining non-empty line is a model (value === label === display name).
 */
export function parseAgyModels(raw: string): ModelOption[] {
  const cleaned = raw
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences (ESC [ … final byte)
    .replace(/\x1B[\]P][\s\S]*?(?:\x07|\x1B\\)/g, '') // OSC/DCS (e.g. window title)
    .replace(/[⠀-⣿]/g, '') // braille spinner frames
    .replace(/Fetching available models\.\.\./gi, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // stray control chars (BEL etc.)
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const line of cleaned.split(/[\r\n]+/)) {
    const name = line.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ value: name, label: name });
  }
  return out;
}

let cachedBinary: string | null = null;
function defaultResolveBinary(): string {
  if (cachedBinary) return cachedBinary;
  try {
    let p = execSync('which agy', { encoding: 'utf-8' }).trim();
    if (p.startsWith('/c/')) p = 'C:/' + p.slice(3);
    if (process.platform === 'win32' && !p.endsWith('.exe')) p += '.exe';
    cachedBinary = p;
  } catch {
    if (process.platform === 'win32') {
      const local = process.env['LOCALAPPDATA'];
      const localAgy = local ? join(local, 'agy', 'bin', 'agy.exe') : null;
      cachedBinary = localAgy && existsSync(localAgy) ? localAgy : 'agy.exe';
    } else {
      cachedBinary = 'agy';
    }
  }
  return cachedBinary;
}

function defaultSpawnPty(file: string, args: string[]): PtyProc {
  return pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 140,
    rows: 50,
    cwd: process.env['USERPROFILE'] || process.cwd(),
    env: process.env as Record<string, string>,
  }) as unknown as PtyProc;
}

export function createAntigravityModelsService(deps: AntigravityModelsDeps = {}) {
  const resolveBinary = deps.resolveBinary ?? defaultResolveBinary;
  const spawnPty = deps.spawnPty ?? defaultSpawnPty;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cache: ModelOption[] | null = null;
  let fetchedAt = 0;
  let inflight: Promise<ModelOption[] | null> | null = null;

  function runFetch(): Promise<ModelOption[] | null> {
    return new Promise((resolve) => {
      let proc: PtyProc;
      try {
        proc = spawnPty(resolveBinary(), ['models']);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'agy models spawn failed; using fallback model list',
        );
        resolve(null);
        return;
      }
      let buf = '';
      let settled = false;
      const finish = (val: ModelOption[] | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => {
        // Only the timeout path kills (node-pty may log a benign conpty warning); the
        // happy path lets `agy models` exit naturally, so no kill is needed.
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        logger.warn('agy models timed out; using fallback model list');
        finish(null);
      }, timeoutMs);
      proc.onData((d) => {
        buf += d;
      });
      proc.onExit(() => {
        const models = parseAgyModels(buf);
        finish(models.length ? models : null);
      });
    });
  }

  function refresh(): Promise<ModelOption[] | null> {
    if (inflight) return inflight;
    inflight = runFetch()
      .then((opts) => {
        if (opts) {
          cache = opts;
          fetchedAt = now();
        }
        return opts ?? cache;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /**
   * Non-blocking: returns the cached list immediately (or null on a cold cache) and
   * triggers a background refresh when stale. Never waits on the PTY fetch.
   */
  async function getModelOptions(): Promise<ModelOption[] | null> {
    if (cache && now() - fetchedAt < ttlMs) return cache;
    void refresh();
    return cache;
  }

  /** Awaitable warm-up for server boot, so the cache is ready before the UI loads. */
  async function warm(): Promise<void> {
    await refresh();
  }

  return { getModelOptions, warm };
}

export type AntigravityModelsService = ReturnType<typeof createAntigravityModelsService>;

/** Process-wide singleton used by the live server. */
export const antigravityModelsService = createAntigravityModelsService();
