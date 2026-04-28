import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createSkillDirectoryService } from '../../../server/services/skill-directory-service';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'server', 'db', 'migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply init migration (creates schema_migrations table)
  const initSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), 'utf-8');
  db.exec(initSql);

  // Apply skill_directories migration
  const skillDirSql = fs.readFileSync(path.join(MIGRATIONS_DIR, '008_skill_directories.sql'), 'utf-8');
  db.exec(skillDirSql);

  return db;
}

describe('SkillDirectoryService', () => {
  let db: Database.Database;
  let service: ReturnType<typeof createSkillDirectoryService>;

  beforeEach(() => {
    db = createTestDb();
    service = createSkillDirectoryService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('add', () => {
    it('creates a skill directory with correct fields', () => {
      const dir = service.add('/home/user/projects/my-project');

      expect(dir.id).toBeGreaterThan(0);
      expect(dir.path).toBe('/home/user/projects/my-project');
      expect(dir.label).toBeNull();
      expect(dir.enabled).toBe(true);
      expect(typeof dir.created_at).toBe('string');
    });

    it('accepts an optional label', () => {
      const dir = service.add('/home/user/projects/my-project', 'My Project');

      expect(dir.label).toBe('My Project');
    });

    it('rejects duplicate paths', () => {
      service.add('/tmp/test');
      expect(() => service.add('/tmp/test')).toThrow(/UNIQUE/);
    });

    it('assigns incrementing IDs', () => {
      const a = service.add('/tmp/a');
      const b = service.add('/tmp/b');

      expect(b.id).toBeGreaterThan(a.id);
    });
  });

  describe('list', () => {
    it('returns all directories', () => {
      service.add('/tmp/a', 'Project A');
      service.add('/tmp/b', 'Project B');
      service.add('/tmp/c');

      const dirs = service.list();
      expect(dirs).toHaveLength(3);
      expect(dirs.map((d) => d.path)).toEqual(['/tmp/a', '/tmp/b', '/tmp/c']);
    });

    it('returns empty array when no directories configured', () => {
      const dirs = service.list();
      expect(dirs).toEqual([]);
    });
  });

  describe('listEnabled', () => {
    it('returns only enabled directories', () => {
      service.add('/tmp/a');
      service.add('/tmp/b');

      // Disable one via direct SQL (no update method exists)
      db.prepare('UPDATE skill_directories SET enabled = 0 WHERE path = ?').run('/tmp/a');

      const enabled = service.listEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].path).toBe('/tmp/b');
    });

    it('returns all when all are enabled', () => {
      service.add('/tmp/a');
      service.add('/tmp/b');

      const enabled = service.listEnabled();
      expect(enabled).toHaveLength(2);
    });
  });

  describe('remove', () => {
    it('removes a directory and returns true', () => {
      const dir = service.add('/tmp/test');
      const result = service.remove(dir.id);

      expect(result).toBe(true);
      expect(service.list()).toHaveLength(0);
    });

    it('returns false for a nonexistent ID', () => {
      const result = service.remove(999);
      expect(result).toBe(false);
    });

    it('only removes the target directory', () => {
      const a = service.add('/tmp/a');
      service.add('/tmp/b');

      service.remove(a.id);
      const remaining = service.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].path).toBe('/tmp/b');
    });
  });
});
