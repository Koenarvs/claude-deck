import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Picks the correct base-URL env var for routing a session through the local
 * Headroom proxy.
 *
 * On Vertex AI (`CLAUDE_CODE_USE_VERTEX` truthy) the Claude CLI IGNORES
 * `ANTHROPIC_BASE_URL` and instead honors `ANTHROPIC_VERTEX_BASE_URL` — and that
 * URL MUST include a `/v1` suffix or the proxy returns 404. For direct-Anthropic
 * auth we fall back to `ANTHROPIC_BASE_URL`.
 */
export function isVertex(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['CLAUDE_CODE_USE_VERTEX'];
  return v != null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export function headroomEnvFragment(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  mode?: 'vertex' | 'oauth',
): Record<string, string> {
  const vertex = mode !== undefined ? mode === 'vertex' : isVertex(env);
  if (vertex) {
    let target = baseUrl.replace(/\/+$/, '');
    if (!target.endsWith('/v1')) target = `${target}/v1`;
    return { ANTHROPIC_VERTEX_BASE_URL: target };
  }
  return { ANTHROPIC_BASE_URL: baseUrl };
}

/**
 * Build the Vertex AI API host for a region, mirroring the Claude CLI's OWN
 * resolution (the bundled `vZe` switch) so the Headroom proxy always forwards to
 * the exact endpoint the CLI would otherwise hit:
 *   - 'global'      → https://aiplatform.googleapis.com
 *   - 'us' / 'eu'   → https://aiplatform.<region>.rep.googleapis.com  (multi-region)
 *   - anything else → https://<region>-aiplatform.googleapis.com      (regional)
 *
 * Deriving the URL from the region — rather than pinning a static config value —
 * is what lets the proxy self-correct when CLOUD_ML_REGION changes: the multi-
 * region 'us'/'eu' endpoints use a different host shape than regional ones, and
 * the naive `<region>-aiplatform...` form produces an invalid host for them.
 */
export function vertexApiUrlForRegion(region: string): string {
  switch (region) {
    case 'global':
      return 'https://aiplatform.googleapis.com';
    case 'us':
    case 'eu':
      return `https://aiplatform.${region}.rep.googleapis.com`;
    default:
      return `https://${region}-aiplatform.googleapis.com`;
  }
}

/**
 * Read CLOUD_ML_REGION from the Claude CLI's OWN settings so the proxy mirrors
 * whatever region the spawned `claude` sessions actually use — even when the deck
 * server's launch shell never exported the var (the common case: a plain
 * `npm run dev` PowerShell). This is what makes the fix truly self-correcting:
 * edit the region in settings.json (the same place the CLI reads) and the proxy
 * follows on the next command build, no shell env or deck config change needed.
 *
 * Mirrors Claude's own precedence at the user scope: `settings.local.json`
 * overrides `settings.json`. Returns undefined when unset/unreadable.
 */
export function regionFromClaudeSettings(home: string = homedir()): string | undefined {
  for (const file of ['settings.local.json', 'settings.json']) {
    try {
      const raw = readFileSync(join(home, '.claude', file), 'utf8');
      const region = (JSON.parse(raw) as { env?: Record<string, string> })?.env?.['CLOUD_ML_REGION'];
      if (typeof region === 'string' && region.trim().length > 0) return region.trim();
    } catch {
      /* missing or invalid — fall through to the next candidate */
    }
  }
  return undefined;
}

/**
 * Resolve the Vertex upstream URL. Precedence — deliberately mirrors the Claude
 * CLI, which applies its `settings.json` `env` block ON TOP of the inherited
 * shell env (so settings win over an ambient CLOUD_ML_REGION):
 *   1. CLOUD_ML_REGION from ~/.claude settings (the CLI's authoritative config,
 *      and the self-correcting source — edit it and the proxy follows), then
 *   2. CLOUD_ML_REGION from the deck's own process env (a fallback when settings
 *      don't pin a region), then
 *   3. 'us-east5' (the CLI's `icn` default when nothing else is set).
 *
 * Settings winning over process env is load-bearing here: a plain `npm run dev`
 * shell can carry a STALE persistent CLOUD_ML_REGION (e.g. a leftover User-scope
 * `us-east5`) that does not match the region the CLI actually uses — honoring the
 * env first is exactly what pointed the proxy at the wrong endpoint.
 *
 * Pure: the settings region is passed in (callers use regionFromClaudeSettings())
 * so this stays free of file IO and fully testable. Read at command-build time so
 * a deck restart — or just editing settings.json — picks up the new region
 * without any code or deck-config change.
 */
export function resolveVertexRegion(
  env: NodeJS.ProcessEnv = process.env,
  settingsRegion?: string,
): string {
  const fromSettings = settingsRegion?.trim();
  if (fromSettings && fromSettings.length > 0) return fromSettings;
  const fromEnv = env['CLOUD_ML_REGION']?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'us-east5';
}

export function resolveVertexApiUrl(
  env: NodeJS.ProcessEnv = process.env,
  settingsRegion?: string,
): string {
  return vertexApiUrlForRegion(resolveVertexRegion(env, settingsRegion));
}
