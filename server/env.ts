import path from 'node:path';

export interface ServerEnv {
  port: number;
  dataDir: string;
  logLevel: string;
  /** Host the HTTP/WS server binds to. Default loopback. */
  bindHost: string;
  /** Whether bindHost is a loopback address (127.0.0.1, ::1, localhost). */
  isLoopback: boolean;
  /** Shared bearer token, or null when none configured. */
  token: string | null;
  /** Absolute, resolved roots a goal cwd must live within. */
  allowedRoots: string[];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // 127.0.0.0/8 is all loopback
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Splits an OS-path list. Accepts ';' (Windows) and ',' — never ':' which is
 * ambiguous on Windows (drive letters).
 */
function parseRoots(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    // Default allow-list: the directory the server runs in (the owner's repo).
    return [path.resolve(process.cwd())];
  }
  return raw
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => path.resolve(p));
}

/**
 * Loads and validates server environment variables, including the
 * security-relevant bind host, shared token, and cwd allow-list.
 *
 * Fail-closed rule: refuses to start if bound to a non-loopback host
 * with no token set.
 */
export function loadEnv(): ServerEnv {
  const rawPort = process.env['PORT'] ?? '4100';
  const port = parseInt(rawPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${rawPort}. Must be between 1 and 65535.`);
  }

  const rawDataDir = process.env['DATA_DIR'] ?? './data';
  const dataDir = path.resolve(rawDataDir);

  const logLevel = process.env['LOG_LEVEL'] ?? 'info';

  const bindHost = (process.env['CLAUDE_DECK_BIND'] ?? '127.0.0.1').trim();
  const isLoopback = isLoopbackHost(bindHost);

  const rawToken = process.env['CLAUDE_DECK_TOKEN'];
  const token = rawToken && rawToken.trim().length > 0 ? rawToken : null;

  // Fail-closed: a LAN-exposed server with no token is an open RCE endpoint.
  if (!isLoopback && token === null) {
    throw new Error(
      `Refusing to start: CLAUDE_DECK_BIND=${bindHost} exposes the server beyond loopback ` +
        `but CLAUDE_DECK_TOKEN is not set. Set CLAUDE_DECK_TOKEN to a shared secret, ` +
        `or bind to 127.0.0.1 for local-only access.`,
    );
  }

  const allowedRoots = parseRoots(process.env['CLAUDE_DECK_ALLOWED_ROOTS']);

  return { port, dataDir, logLevel, bindHost, isLoopback, token, allowedRoots };
}
