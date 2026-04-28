import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScannedSkill {
  name: string;
  description: string;
  scope: string;
  type: string;
  path: string;
  /** Raw SKILL.md content — populated only when `includeContent` is true. */
  content?: string;
}

export interface ScanOptions {
  /** Additional directories to scan (e.g. custom user-configured directories). */
  extraDirs?: string[];
  /** If true, reads and attaches the full SKILL.md content to each skill. */
  includeContent?: boolean;
}

// ── Scanner ─────────────────────────────────────────────────────────────────

const SURFACE_TYPES = ['skills', 'agents', 'hooks', 'commands'] as const;

/**
 * Scans for Claude Code skills in known locations (project .claude/, user ~/.claude/)
 * and optionally in additional custom directories.
 *
 * This is the single source of truth for skill scanning — used by both the
 * GET /api/skills HTTP endpoint and the session runner for prompt injection.
 *
 * @param options - Optional extra directories and content flags
 * @returns Array of discovered skills
 */
export function scanSkills(options?: ScanOptions): ScannedSkill[] {
  const skills: ScannedSkill[] = [];

  const locations: Array<{ dir: string; scope: string; surfaceType: string }> = [];

  for (const surface of SURFACE_TYPES) {
    locations.push({ dir: path.join(process.cwd(), '.claude', surface), scope: 'project', surfaceType: surface });
    locations.push({ dir: path.join(os.homedir(), '.claude', surface), scope: 'user', surfaceType: surface });
  }

  // Add custom directories
  if (options?.extraDirs) {
    for (const d of options.extraDirs) {
      const trimmed = d.trim();
      if (!trimmed) continue;

      const normalised = trimmed.replace(/\\/g, '/');
      const claudeIdx = normalised.indexOf('/.claude/');
      if (claudeIdx !== -1) {
        // Path already points inside .claude — use as-is
        locations.push({
          dir: trimmed,
          scope: 'custom',
          surfaceType: normalised.split('/.claude/')[1]?.split('/')[0] ?? 'skills',
        });
      } else {
        for (const surface of SURFACE_TYPES) {
          const surfaceDir = path.join(trimmed, '.claude', surface);
          locations.push({ dir: surfaceDir, scope: 'custom', surfaceType: surface });
        }
      }
    }
  }

  for (const loc of locations) {
    try {
      if (!fs.existsSync(loc.dir)) continue;
      const entries = fs.readdirSync(loc.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillFile = path.join(loc.dir, entry.name, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            const fileContent = fs.readFileSync(skillFile, 'utf-8');
            const descMatch = fileContent.match(/description:\s*(.+)/);
            const desc = descMatch ? descMatch[1].trim() : '';
            const skill: ScannedSkill = {
              name: entry.name,
              description: desc,
              scope: loc.scope,
              type: loc.surfaceType,
              path: skillFile,
            };
            if (options?.includeContent) {
              skill.content = fileContent;
            }
            skills.push(skill);
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const fileContent = fs.readFileSync(path.join(loc.dir, entry.name), 'utf-8');
          const descMatch = fileContent.match(/description:\s*(.+)/);
          const desc = descMatch ? descMatch[1].trim() : '';
          const skill: ScannedSkill = {
            name: entry.name.replace('.md', ''),
            description: desc,
            scope: loc.scope,
            type: loc.surfaceType,
            path: path.join(loc.dir, entry.name),
          };
          if (options?.includeContent) {
            skill.content = fileContent;
          }
          skills.push(skill);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  return skills;
}

/**
 * Scans only the given directories for skills, returning full SKILL.md content.
 * Used by the session runner to build the skills context block for prompt injection.
 *
 * @param dirs - Array of directory paths to scan
 * @param excludeCwd - If provided, skills whose path is under this directory are filtered out
 *                     (they are auto-discovered by Claude Code and don't need injection)
 * @returns Array of skills with content populated
 */
export function scanSkillsForInjection(dirs: string[], excludeCwd?: string): ScannedSkill[] {
  const skills = scanSkills({ extraDirs: dirs, includeContent: true });

  // Only keep skills from custom dirs (not project/user scope — those are auto-discovered)
  let filtered = skills.filter((s) => s.scope === 'custom');

  // Exclude skills whose path falls under the goal's cwd (auto-discovered by Claude Code)
  if (excludeCwd) {
    const normCwd = excludeCwd.replace(/\\/g, '/').toLowerCase();
    filtered = filtered.filter((s) => {
      const normPath = s.path.replace(/\\/g, '/').toLowerCase();
      return !normPath.startsWith(normCwd);
    });
  }

  return filtered;
}
