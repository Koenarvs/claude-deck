import type Database from 'better-sqlite3';
import logger from '../logger';

// ── Row ↔ Domain Conversion ──────────────────────────────────────────────────

export interface SkillDirectory {
  id: number;
  path: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
}

interface SkillDirectoryRow {
  id: number;
  path: string;
  label: string | null;
  enabled: number;
  created_at: string;
}

/**
 * Converts a raw SQLite row into a typed SkillDirectory domain object.
 */
function rowToSkillDirectory(row: SkillDirectoryRow): SkillDirectory {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    enabled: row.enabled === 1,
    created_at: row.created_at,
  };
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Creates a SkillDirectoryService bound to the given database instance.
 * Manages custom skill directory configuration for session-time skill injection.
 *
 * @param db - better-sqlite3 database instance (production or :memory: for tests)
 */
export function createSkillDirectoryService(db: Database.Database) {
  // ── Prepared Statements ──────────────────────────────────────────────────

  const insertStmt = db.prepare<[string, string | null]>(
    `INSERT INTO skill_directories (path, label) VALUES (?, ?)`,
  );

  const listStmt = db.prepare<[], SkillDirectoryRow>(
    'SELECT * FROM skill_directories ORDER BY created_at ASC',
  );

  const listEnabledStmt = db.prepare<[], SkillDirectoryRow>(
    'SELECT * FROM skill_directories WHERE enabled = 1 ORDER BY created_at ASC',
  );

  const getByIdStmt = db.prepare<[number], SkillDirectoryRow>(
    'SELECT * FROM skill_directories WHERE id = ?',
  );

  const deleteStmt = db.prepare<[number]>(
    'DELETE FROM skill_directories WHERE id = ?',
  );

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Lists all configured skill directories.
   *
   * @returns Array of SkillDirectory
   */
  function list(): SkillDirectory[] {
    const rows = listStmt.all();
    return rows.map(rowToSkillDirectory);
  }

  /**
   * Lists only enabled skill directories.
   *
   * @returns Array of enabled SkillDirectory
   */
  function listEnabled(): SkillDirectory[] {
    const rows = listEnabledStmt.all();
    return rows.map(rowToSkillDirectory);
  }

  /**
   * Adds a new skill directory.
   *
   * @param dirPath - Filesystem path to the directory
   * @param label - Optional friendly name
   * @returns The created SkillDirectory
   * @throws Error if the path already exists (UNIQUE constraint)
   */
  function add(dirPath: string, label?: string): SkillDirectory {
    const result = insertStmt.run(dirPath, label ?? null);
    const id = Number(result.lastInsertRowid);

    const row = getByIdStmt.get(id);
    if (!row) {
      throw new Error(`Failed to create skill directory: row not found after insert (id=${id})`);
    }

    const skillDir = rowToSkillDirectory(row);
    logger.info({ id, path: dirPath, label }, 'Skill directory added');
    return skillDir;
  }

  /**
   * Removes a skill directory by ID.
   *
   * @param id - The skill directory ID
   * @returns true if deleted, false if not found
   */
  function remove(id: number): boolean {
    const result = deleteStmt.run(id);
    if (result.changes > 0) {
      logger.info({ id }, 'Skill directory removed');
      return true;
    }
    return false;
  }

  return {
    list,
    listEnabled,
    add,
    remove,
  };
}

export type SkillDirectoryService = ReturnType<typeof createSkillDirectoryService>;
