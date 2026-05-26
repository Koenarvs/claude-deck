import { readFileSync, writeFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import logger from '../logger';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillVersion {
  id: string;
  skill_name: string;
  skill_path: string;
  version_number: number;
  content_snapshot: string;
  change_reason: string | null;
  created_at: number;
}

interface VersionRow {
  id: string;
  skill_name: string;
  skill_path: string;
  version_number: number;
  content_snapshot: string;
  change_reason: string | null;
  created_at: number;
}

export class StaleContentError extends Error {
  constructor(skillName: string) {
    super(`SKILL.md for "${skillName}" has been modified since the suggestion was generated`);
    this.name = 'StaleContentError';
  }
}

// ── Diff Application ────────────────────────────────────────────────────────

function applyUnifiedDiff(original: string, diff: string): string {
  const lines = original.split('\n');
  const diffLines = diff.split('\n');
  const result: string[] = [...lines];
  let offset = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) continue;

    const origStart = parseInt(hunkMatch[1], 10) - 1;
    let pos = origStart + offset;
    i++;

    const removals: number[] = [];
    const additions: { index: number; text: string }[] = [];

    while (i < diffLines.length) {
      const dl = diffLines[i];
      if (dl.startsWith('@@') || dl.startsWith('--- ') || dl.startsWith('+++ ')) {
        i--;
        break;
      }
      if (dl.startsWith('-')) {
        removals.push(pos);
        pos++;
      } else if (dl.startsWith('+')) {
        additions.push({ index: pos, text: dl.slice(1) });
      } else {
        pos++;
      }
      i++;
    }

    // Apply removals in reverse order
    for (let r = removals.length - 1; r >= 0; r--) {
      result.splice(removals[r], 1);
      offset--;
    }

    // Apply additions
    let addOffset = 0;
    for (const add of additions) {
      const insertAt = add.index + addOffset;
      result.splice(insertAt, 0, add.text);
      offset++;
      addOffset++;
    }
  }

  return result.join('\n');
}

// ── Content Hash ────────────────────────────────────────────────────────────

function computeContentHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

// ── Service ─────────────────────────────────────────────────────────────────

export function createSkillFileService(db: Database.Database) {
  const insertVersionStmt = db.prepare<[string, string, string, number, string, string | null, number]>(
    `INSERT INTO skill_versions (id, skill_name, skill_path, version_number, content_snapshot, change_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const getLatestVersionStmt = db.prepare<[string], { version_number: number }>(
    `SELECT version_number FROM skill_versions WHERE skill_name = ? ORDER BY version_number DESC LIMIT 1`,
  );

  const getVersionsStmt = db.prepare<[string], VersionRow>(
    `SELECT * FROM skill_versions WHERE skill_name = ? ORDER BY version_number DESC`,
  );

  const getVersionByIdStmt = db.prepare<[string], VersionRow>(
    `SELECT * FROM skill_versions WHERE id = ?`,
  );

  function applySuggestion(
    skillPath: string,
    skillName: string,
    diffContent: string,
    changeReason: string,
    expectedHash?: string | null,
  ): { newContent: string; version: SkillVersion } {
    let currentContent: string;
    try {
      currentContent = readFileSync(skillPath, 'utf-8');
    } catch (err) {
      logger.error({ err, skillPath }, 'Failed to read SKILL.md for applying suggestion');
      throw new Error(`Cannot read skill file: ${skillPath}`);
    }

    // Stale content detection
    if (expectedHash) {
      const currentHash = computeContentHash(currentContent);
      if (currentHash !== expectedHash) {
        throw new StaleContentError(skillName);
      }
    }

    // Snapshot current version before modification
    const latestVersion = getLatestVersionStmt.get(skillName);
    const nextVersionNumber = (latestVersion?.version_number ?? 0) + 1;
    const versionId = uuidv4();
    const now = Date.now();

    insertVersionStmt.run(
      versionId,
      skillName,
      skillPath,
      nextVersionNumber,
      currentContent,
      changeReason,
      now,
    );

    // Apply the diff
    const newContent = applyUnifiedDiff(currentContent, diffContent);

    // Write the updated file
    writeFileSync(skillPath, newContent, 'utf-8');

    logger.info({ skillName, skillPath, versionNumber: nextVersionNumber }, 'Skill file updated with suggestion');

    return {
      newContent,
      version: {
        id: versionId,
        skill_name: skillName,
        skill_path: skillPath,
        version_number: nextVersionNumber,
        content_snapshot: currentContent,
        change_reason: changeReason,
        created_at: now,
      },
    };
  }

  function revertToVersion(versionId: string): { newContent: string; version: SkillVersion } {
    const version = getVersionByIdStmt.get(versionId);
    if (!version) throw new Error(`Version not found: ${versionId}`);

    // Snapshot current content before revert
    let currentContent: string;
    try {
      currentContent = readFileSync(version.skill_path, 'utf-8');
    } catch {
      currentContent = '';
    }

    const latestVersion = getLatestVersionStmt.get(version.skill_name);
    const nextVersionNumber = (latestVersion?.version_number ?? 0) + 1;
    const revertVersionId = uuidv4();
    const now = Date.now();

    insertVersionStmt.run(
      revertVersionId,
      version.skill_name,
      version.skill_path,
      nextVersionNumber,
      currentContent,
      `Reverted to version ${version.version_number}`,
      now,
    );

    // Write the old content back
    writeFileSync(version.skill_path, version.content_snapshot, 'utf-8');

    logger.info({ skillName: version.skill_name, revertedTo: version.version_number }, 'Skill file reverted');

    return {
      newContent: version.content_snapshot,
      version: {
        id: revertVersionId,
        skill_name: version.skill_name,
        skill_path: version.skill_path,
        version_number: nextVersionNumber,
        content_snapshot: currentContent,
        change_reason: `Reverted to version ${version.version_number}`,
        created_at: now,
      },
    };
  }

  function getVersionHistory(skillName: string): SkillVersion[] {
    return getVersionsStmt.all(skillName);
  }

  function getVersion(id: string): SkillVersion | null {
    return getVersionByIdStmt.get(id) ?? null;
  }

  return {
    applySuggestion,
    revertToVersion,
    getVersionHistory,
    getVersion,
    computeContentHash,
  };
}

export type SkillFileService = ReturnType<typeof createSkillFileService>;
