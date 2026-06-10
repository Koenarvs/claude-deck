import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createCwdValidator } from '../../../server/security/path-allow';

describe('cwd validator', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-root-')));
  const inside = fs.mkdtempSync(path.join(root, 'goal-'));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-out-')));
  const validate = createCwdValidator({ allowedRoots: [root] });

  it('accepts an existing dir inside an allowed root', () => {
    expect(validate(inside)).toEqual({ ok: true, resolved: fs.realpathSync(inside) });
  });

  it('rejects a relative path', () => {
    const r = validate('some/rel/path');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute/i);
  });

  it('rejects a non-existent path', () => {
    const r = validate(path.join(root, 'does-not-exist'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exist/i);
  });

  it('rejects a dir outside all allowed roots', () => {
    const r = validate(outside);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allowed/i);
  });

  it('rejects a traversal that escapes the root after resolution', () => {
    const escape = path.join(inside, '..', '..', '..');
    const r = validate(escape);
    expect(r.ok).toBe(false);
  });

  it('accepts the root itself', () => {
    expect(validate(root).ok).toBe(true);
  });
});
