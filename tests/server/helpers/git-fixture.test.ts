import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, cleanupTempRepo } from './git-fixture';

describe('makeTempRepo', () => {
  let repo: string | null = null;
  afterEach(() => {
    if (repo) {
      cleanupTempRepo(repo);
      repo = null;
    }
  });

  it('creates an initialized repo with one commit on a known branch', () => {
    repo = makeTempRepo();
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    expect(branch).toBe('main');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(log).toContain('init');
  });

  it('lets a caller add a tracked file and see it dirty', () => {
    repo = makeTempRepo();
    fs.writeFileSync(path.join(repo, 'new.txt'), 'hello');
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repo,
      encoding: 'utf-8',
    }).trim();
    expect(status).toContain('new.txt');
  });
});
