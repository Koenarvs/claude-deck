import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthMode } from '../src/shared/schemas';
import { isVertex } from './headroom-env';

export type ResolvedAuthMode = 'vertex' | 'oauth';

/**
 * Read CLAUDE_CODE_USE_VERTEX from the Claude CLI's own settings env block,
 * mirroring regionFromClaudeSettings(): settings.local.json wins over
 * settings.json. Returns undefined when neither file pins the var — the caller
 * falls through to its next detection source.
 *
 * This matters on multi-PC installs: the CLI applies its settings env block on
 * top of the inherited shell env, so a machine can be Vertex-configured even
 * when the deck's launch shell (a plain `npm run dev` PowerShell) never
 * exported the var.
 */
export function vertexFromClaudeSettings(home: string = homedir()): boolean | undefined {
  for (const file of ['settings.local.json', 'settings.json']) {
    try {
      const raw = readFileSync(join(home, '.claude', file), 'utf8');
      const v = (JSON.parse(raw) as { env?: Record<string, string> })?.env?.['CLAUDE_CODE_USE_VERTEX'];
      if (typeof v === 'string' && v.trim() !== '') {
        return isVertex({ CLAUDE_CODE_USE_VERTEX: v.trim() });
      }
    } catch {
      /* missing or invalid — fall through to the next candidate */
    }
  }
  return undefined;
}

/**
 * Resolve the configured auth mode to a concrete one. Explicit 'vertex'/'oauth'
 * wins unconditionally (that's the point of the setting — override ambient env
 * on machines where the shell doesn't match the intended auth). 'auto' detects:
 *   1. CLAUDE_CODE_USE_VERTEX in the deck server's env (truthy → vertex,
 *      explicit '0'/'false' → oauth),
 *   2. CLAUDE_CODE_USE_VERTEX in the CLI's ~/.claude settings env block,
 *   3. otherwise OAuth (the CLI's own default — credentials file or login flow).
 */
export function resolveAuthMode(
  mode: AuthMode,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ResolvedAuthMode {
  if (mode === 'vertex' || mode === 'oauth') return mode;
  const raw = env['CLAUDE_CODE_USE_VERTEX'];
  if (raw != null && raw !== '') return isVertex(env) ? 'vertex' : 'oauth';
  const fromSettings = vertexFromClaudeSettings(home);
  if (fromSettings !== undefined) return fromSettings ? 'vertex' : 'oauth';
  return 'oauth';
}
