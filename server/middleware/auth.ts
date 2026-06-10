import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import logger from '../logger';

export interface ApiAuthConfig {
  /** Shared secret. null = no token configured → allow all (loopback dev). */
  token: string | null;
}

/** Paths under /api that never require the token (liveness probes). */
const EXEMPT_PATHS = new Set(['/health']);

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Extracts the presented token from the request: `Authorization: Bearer <t>`,
 * the `X-Claude-Deck-Token` header, or a `?token=` query param (WS-style
 * fallback for browsers that can't set headers). Returns null if absent.
 */
export function extractToken(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim() || null;
  }
  const hdr = req.headers['x-claude-deck-token'];
  if (typeof hdr === 'string' && hdr.trim().length > 0) return hdr.trim();
  const q = (req.query as Record<string, unknown>)['token'];
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

/**
 * Creates the /api bearer-token middleware.
 * - token === null → no-op (frictionless loopback dev).
 * - token set → require a matching token on every /api request except EXEMPT_PATHS.
 */
export function createApiAuthMiddleware(config: ApiAuthConfig): RequestHandler {
  const { token } = config;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (token === null) {
      next();
      return;
    }
    // req.path here is relative to the /api mount, e.g. '/health', '/goals'.
    if (EXEMPT_PATHS.has(req.path)) {
      next();
      return;
    }
    const presented = extractToken(req);
    if (presented !== null && safeEqual(presented, token)) {
      next();
      return;
    }
    logger.warn({ path: req.path, ip: req.ip }, 'Rejected unauthenticated /api request');
    res.status(401).json({ error: 'Unauthorized' });
  };
}
