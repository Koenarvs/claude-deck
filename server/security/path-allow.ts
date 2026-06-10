import path from 'node:path';
import fs from 'node:fs';

export type CwdValidation =
  | { ok: true; resolved: string }
  | { ok: false; reason: string };

export interface CwdValidatorConfig {
  /** Absolute roots a cwd must live within. */
  allowedRoots: string[];
}

/** True if `child` equals `parent` or is nested under it (case-insensitive on Windows). */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  // Same dir → '' ; nested → no leading '..' and not absolute.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Builds a cwd validator over a fixed allow-list. The returned function:
 * - requires an absolute path,
 * - requires the path to exist (real, resolving symlinks),
 * - requires the resolved real path to be within one of the allowed roots.
 *
 * Phase 5A handoff: replace `allowedRoots` with ProjectService.isPathAllowed()
 * by swapping this factory's source — call sites take the returned function and
 * are unaffected.
 */
export function createCwdValidator(config: CwdValidatorConfig) {
  const roots = config.allowedRoots.map((r) => {
    try {
      return fs.realpathSync(path.resolve(r));
    } catch {
      return path.resolve(r);
    }
  });

  return function validate(rawCwd: string): CwdValidation {
    if (!path.isAbsolute(rawCwd)) {
      return { ok: false, reason: 'cwd must be an absolute path' };
    }
    let resolved: string;
    try {
      resolved = fs.realpathSync(rawCwd); // resolves symlinks; throws if missing
    } catch {
      return { ok: false, reason: 'cwd does not exist' };
    }
    const allowed = roots.some((root) => isWithin(root, resolved));
    if (!allowed) {
      return { ok: false, reason: 'cwd is not within an allowed root' };
    }
    return { ok: true, resolved };
  };
}

export type CwdValidator = ReturnType<typeof createCwdValidator>;
