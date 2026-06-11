import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a throwaway git repo in the OS temp dir with one commit on branch `main`. Returns its absolute path. */
export function makeTempRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-git-')));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  // Avoid Windows dubious-ownership noise inside the fixture itself.
  try {
    execFileSync('git', ['config', '--global', '--add', 'safe.directory', dir.replace(/\\/g, '/')]);
  } catch {
    /* best effort */
  }
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
  return dir;
}

/** Removes a temp repo created by makeTempRepo. Best-effort; ignores errors. */
export function cleanupTempRepo(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
