import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../server/db/migrate';
import { createSkillFileService, StaleContentError } from '../../../server/services/skill-file-service';

vi.mock('../../../server/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let db: Database.Database;
let dir: string;
let skillPath: string;
let svc: ReturnType<typeof createSkillFileService>;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-'));
  skillPath = path.join(dir, 'SKILL.md');
  fs.writeFileSync(skillPath, 'original content', 'utf-8');
  svc = createSkillFileService(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('saveSkillContent', () => {
  it('writes the new content and snapshots the old content as a version row', () => {
    const { version } = svc.saveSkillContent(skillPath, 'my-skill', 'new content', 'edited in UI');

    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('new content');
    expect(version.version_number).toBe(1);
    expect(version.content_snapshot).toBe('original content'); // pre-edit snapshot
    expect(version.change_reason).toBe('edited in UI');

    const history = svc.getVersionHistory('my-skill');
    expect(history).toHaveLength(1);
    expect(history[0].content_snapshot).toBe('original content');
  });

  it('increments version numbers across successive saves', () => {
    svc.saveSkillContent(skillPath, 'my-skill', 'v2', 'r1');
    const second = svc.saveSkillContent(skillPath, 'my-skill', 'v3', 'r2');
    expect(second.version.version_number).toBe(2);
    expect(second.version.content_snapshot).toBe('v2');
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('v3');
  });

  it('throws StaleContentError when expectedHash does not match (and leaves the file untouched)', () => {
    expect(() =>
      svc.saveSkillContent(skillPath, 'my-skill', 'new', 'r', 'deadbeef-wrong-hash'),
    ).toThrow(StaleContentError);
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('original content');
    expect(svc.getVersionHistory('my-skill')).toHaveLength(0);
  });

  it('succeeds when expectedHash matches the current content', () => {
    const hash = svc.computeContentHash('original content');
    const { version } = svc.saveSkillContent(skillPath, 'my-skill', 'updated', 'r', hash);
    expect(version.version_number).toBe(1);
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe('updated');
  });
});
