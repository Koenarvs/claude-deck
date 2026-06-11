import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMigratedDb } from '../helpers/db-fixture';
import {
  createProjectService,
  isPathAllowedAgainst,
  DuplicateProjectRootError,
} from '../../../server/services/project-service';
import type Database from 'better-sqlite3';

vi.mock('../../../server/ws', () => ({ broadcast: vi.fn() }));
vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
beforeEach(() => {
  db = makeMigratedDb();
});
afterEach(() => db.close());

describe('ProjectService CRUD', () => {
  it('creates and reads a project with defaults applied', () => {
    const svc = createProjectService(db);
    const p = svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    expect(p.id).toBeTruthy();
    expect(p.allowed_models).toEqual([]);
    expect(p.default_permission_mode).toBe('supervised');
    expect(svc.get(p.id)?.root_path).toBe('c:/github/claude-deck'); // drive-letter normalized
  });

  it('rejects duplicate root_path', () => {
    const svc = createProjectService(db);
    svc.create({ name: 'A', root_path: 'C:/repo' });
    expect(() => svc.create({ name: 'B', root_path: 'C:/repo' })).toThrow(DuplicateProjectRootError);
  });

  it('updates fields and removes', () => {
    const svc = createProjectService(db);
    const p = svc.create({ name: 'A', root_path: 'C:/repo' });
    const u = svc.update(p.id, { done_command: 'npm test', allowed_models: ['opus'] });
    expect(u.done_command).toBe('npm test');
    expect(u.allowed_models).toEqual(['opus']);
    svc.remove(p.id);
    expect(svc.get(p.id)).toBeNull();
  });
});

describe('isPathAllowed (allow-list)', () => {
  it('allows a cwd inside a registered root and rejects outside', () => {
    const svc = createProjectService(db);
    svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    expect(svc.isPathAllowed('C:/github/claude-deck')).toBe(true);
    expect(svc.isPathAllowed('C:/github/claude-deck/server')).toBe(true);
    expect(svc.isPathAllowed('C:/github/other')).toBe(false);
  });

  it('rejects path-escape and prefix-collision attempts', () => {
    const svc = createProjectService(db);
    svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    expect(svc.isPathAllowed('C:/github/claude-deck-evil')).toBe(false); // prefix collision
    expect(svc.isPathAllowed('C:/github/claude-deck/../other')).toBe(false); // traversal
    expect(svc.isPathAllowed('C:\\github\\claude-deck\\server')).toBe(true); // backslash normalizes
  });

  it('free function matches the method', () => {
    const svc = createProjectService(db);
    svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    expect(isPathAllowedAgainst(svc.list(), 'C:/github/claude-deck/x')).toBe(true);
    expect(isPathAllowedAgainst(svc.list(), 'C:/elsewhere')).toBe(false);
  });

  it('empty registry denies everything (fail-closed)', () => {
    const svc = createProjectService(db);
    expect(svc.isPathAllowed('C:/anything')).toBe(false);
    expect(isPathAllowedAgainst([], 'C:/anything')).toBe(false);
  });

  it('findByCwd returns the containing project', () => {
    const svc = createProjectService(db);
    const p = svc.create({ name: 'Deck', root_path: 'C:/github/claude-deck' });
    expect(svc.findByCwd('C:/github/claude-deck/src')?.id).toBe(p.id);
    expect(svc.findByCwd('C:/nope')).toBeNull();
  });
});
