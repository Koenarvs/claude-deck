import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSkills, scanSkillsForInjection } from '../../server/skill-scanner';

let tmpDir: string;

function createSkillDir(basePath: string, skillName: string, content: string): void {
  const skillDir = path.join(basePath, '.claude', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
}

describe('skill-scanner', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scanner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('scanSkills', () => {
    it('discovers skills in extra directories', () => {
      createSkillDir(tmpDir, 'test-skill', 'description: A test skill\n\nDo something');

      const skills = scanSkills({ extraDirs: [tmpDir] });
      const customSkills = skills.filter((s) => s.scope === 'custom');

      expect(customSkills.length).toBeGreaterThanOrEqual(1);
      const found = customSkills.find((s) => s.name === 'test-skill');
      expect(found).toBeDefined();
      expect(found!.description).toBe('A test skill');
      expect(found!.type).toBe('skills');
    });

    it('does not include content by default', () => {
      createSkillDir(tmpDir, 'no-content', 'description: Skill without content');

      const skills = scanSkills({ extraDirs: [tmpDir] });
      const found = skills.find((s) => s.name === 'no-content');
      expect(found).toBeDefined();
      expect(found!.content).toBeUndefined();
    });

    it('includes content when includeContent is true', () => {
      const fullContent = 'description: Content skill\n\nHere is the full content.';
      createSkillDir(tmpDir, 'with-content', fullContent);

      const skills = scanSkills({ extraDirs: [tmpDir], includeContent: true });
      const found = skills.find((s) => s.name === 'with-content');
      expect(found).toBeDefined();
      expect(found!.content).toBe(fullContent);
    });

    it('handles empty extra dirs array', () => {
      const skills = scanSkills({ extraDirs: [] });
      // Should not throw — project/user scope skills may or may not exist
      expect(Array.isArray(skills)).toBe(true);
    });

    it('handles nonexistent directories gracefully', () => {
      const skills = scanSkills({ extraDirs: ['/nonexistent/path/12345'] });
      const custom = skills.filter((s) => s.scope === 'custom');
      expect(custom).toHaveLength(0);
    });

    it('discovers standalone .md files as skills', () => {
      const skillsDir = path.join(tmpDir, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'standalone.md'), 'description: A standalone skill');

      const skills = scanSkills({ extraDirs: [tmpDir] });
      const found = skills.find((s) => s.name === 'standalone');
      expect(found).toBeDefined();
      expect(found!.description).toBe('A standalone skill');
    });
  });

  describe('scanSkillsForInjection', () => {
    it('returns only custom-scope skills with content', () => {
      createSkillDir(tmpDir, 'inject-me', 'description: Injectable\n\nFull instructions.');

      const skills = scanSkillsForInjection([tmpDir]);
      expect(skills.length).toBeGreaterThanOrEqual(1);

      const found = skills.find((s) => s.name === 'inject-me');
      expect(found).toBeDefined();
      expect(found!.content).toBe('description: Injectable\n\nFull instructions.');
      expect(found!.scope).toBe('custom');
    });

    it('excludes skills under the cwd', () => {
      const projDir = path.join(tmpDir, 'project-a');
      const otherDir = path.join(tmpDir, 'project-b');

      createSkillDir(projDir, 'cwd-skill', 'description: In CWD');
      createSkillDir(otherDir, 'external-skill', 'description: External');

      const skills = scanSkillsForInjection([projDir, otherDir], projDir);

      const cwdSkill = skills.find((s) => s.name === 'cwd-skill');
      const extSkill = skills.find((s) => s.name === 'external-skill');

      expect(cwdSkill).toBeUndefined();
      expect(extSkill).toBeDefined();
    });

    it('returns empty array when no dirs provided', () => {
      const skills = scanSkillsForInjection([]);
      expect(skills).toEqual([]);
    });

    it('handles case-insensitive path comparison on Windows', () => {
      // This tests the normalize-and-lowercase logic
      createSkillDir(tmpDir, 'case-test', 'description: Case test');

      const upperCwd = tmpDir.toUpperCase();
      const skills = scanSkillsForInjection([tmpDir], upperCwd);

      // All skills from tmpDir should be excluded because cwd matches (case-insensitive)
      const found = skills.find((s) => s.name === 'case-test');
      expect(found).toBeUndefined();
    });
  });
});
