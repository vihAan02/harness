// Throwaway homes and Git repos for daemon tests.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessHome, type Home } from '../src/home.ts';

export const TOKEN = 'daemon-test-token-'.padEnd(48, 'x');

/** A temp dir with symlinks resolved (macOS's /var is /private/var). Removed by `cleanup`. */
export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `harness-${prefix}-`)));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function tempHome(root: string): Home {
  const home = harnessHome(path.join(root, 'harness-home'));
  fs.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(home.token, TOKEN, { mode: 0o600 });
  return home;
}

/** Test-side Git (setting up scenarios). Hooks are off, so hook markers only ever come from harnessd's own Git. */
export const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();

/** A repo on `main` with one commit containing `files`. Returns its path and the commit SHA. */
export function makeRepo(root: string, files: Record<string, string>): { repo: string; sha: string } {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  gitIn(repo, 'init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'base');
  return { repo, sha: gitIn(repo, 'rev-parse', 'HEAD') };
}
