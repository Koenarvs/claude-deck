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
): Record<string, string> {
  if (isVertex(env)) {
    let target = baseUrl.replace(/\/+$/, '');
    if (!target.endsWith('/v1')) target = `${target}/v1`;
    return { ANTHROPIC_VERTEX_BASE_URL: target };
  }
  return { ANTHROPIC_BASE_URL: baseUrl };
}
