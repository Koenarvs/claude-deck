import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ModelOption } from '../../src/shared/agents/types';
import logger from '../logger';

/**
 * Fetches the live list of Anthropic models the signed-in account can use — the
 * same set the Claude CLI shows under `/model` — so the goal model picker offers
 * every concrete version (Opus 4.8/4.7/4.6/…, Sonnet 4.6/4.5/…, Haiku 4.5, Fable 5)
 * instead of the generic opus/sonnet/haiku aliases.
 *
 * Source: GET https://api.anthropic.com/v1/models, authorized with the Claude Code
 * OAuth access token from ~/.claude/.credentials.json (scope user:inference). No
 * API key is required. The result is cached with a TTL; callers fall back to the
 * static registry-derived list when this returns null (offline / token expired /
 * not signed in), so the picker always works.
 */

const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour — the model list changes rarely
const DEFAULT_TIMEOUT_MS = 4000; // per-attempt hang ceiling before aborting
// The endpoint resets connections (ECONNRESET) sporadically; resets fail fast, so a
// few retries make a single getModelOptions() call reliable without much added latency.
const DEFAULT_MAX_ATTEMPTS = 3;

interface ModelsResponse {
  data?: Array<{ id?: string; display_name?: string }>;
}

export interface ClaudeModelsDeps {
  /** Returns a usable OAuth access token, or null if absent/expired. */
  readToken?: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  /** Attempts per fetch before giving up to the fallback (transient resets). */
  maxAttempts?: number;
  /** Sleep used for backoff between retries (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Reads the Claude Code OAuth access token, treating an expired token as absent. */
function defaultReadToken(): string | null {
  try {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    const cred = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const oauth = cred.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

export function createClaudeModelsService(deps: ClaudeModelsDeps = {}) {
  const readToken = deps.readToken ?? defaultReadToken;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let cache: ModelOption[] | null = null;
  let fetchedAt = 0;
  let inflight: Promise<ModelOption[] | null> | null = null;

  /** One HTTP attempt. Returns options, or throws on a network error (caller retries). */
  async function fetchOnce(token: string): Promise<ModelOption[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(MODELS_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        // Auth/other server error — retrying will not help; fall back immediately.
        logger.warn({ status: res.status }, 'Anthropic /v1/models returned non-OK; using fallback model list');
        return null;
      }
      const body = (await res.json()) as ModelsResponse;
      const models = (body.data ?? [])
        .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
        .map((m) => ({ value: m.id, label: m.display_name ?? m.id }));
      if (models.length === 0) return null;
      // The 'default' sentinel ("let the CLI choose the latest") is Claude-specific
      // and not returned by the API, so it is prepended.
      return [{ value: 'default', label: 'Default' }, ...models];
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchOptions(): Promise<ModelOption[] | null> {
    const token = readToken();
    if (!token) return null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fetchOnce(token);
      } catch (err) {
        // Transient network error (the endpoint resets connections sporadically).
        if (attempt >= maxAttempts) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), attempts: attempt },
            'Anthropic /v1/models fetch failed; using fallback model list',
          );
          return null;
        }
        await sleep(150 * attempt);
      }
    }
    return null;
  }

  /**
   * Returns the cached model options, refreshing if stale. Concurrent callers share
   * one in-flight fetch. Returns null when no list is available (caller falls back).
   * A successful result is cached; a failure leaves any prior cache intact.
   */
  async function getModelOptions(): Promise<ModelOption[] | null> {
    if (cache && now() - fetchedAt < ttlMs) return cache;
    if (inflight) return inflight;
    inflight = fetchOptions()
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

  return { getModelOptions };
}

export type ClaudeModelsService = ReturnType<typeof createClaudeModelsService>;

/** Process-wide singleton used by the live server (see server/routes/system.ts). */
export const claudeModelsService = createClaudeModelsService();
