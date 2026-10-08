// Git operations. harnessd owns every Git write: worktrees, branches and commits (D-50).
// Every call disables hooks and fsmonitor, so nothing in a repo's .git/hooks, a configured hooksPath
// or a configured fsmonitor program runs on harnessd's behalf (TH-14).
//
// A linked worktree's `.git` file is the agent's to write (it's inside the worktree), so harnessd's Git never
// follows it (TH-25, D-114). harnessd registers its worktree roots and its projects' repositories
// (guardWorktrees). Any call whose directory is inside a guarded root is pinned to that worktree's admin
// directory, found from the main repository's shared .git, which agents can't write. It's pinned with
// --git-dir and --work-tree, and reads no global or system config, so a redirected `.git` can't hand
// harnessd another repository's config, filters or hooks. A directory there that isn't a worktree of a
// project repository is refused.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

export const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/;

const guard = { roots: new Set<string>(), repos: new Set<string>() };
const pins = new Map<string, string>(); // a worktree (real path) → its admin directory
const commonDirs = new Map<string, string>(); // a project repository → its shared .git

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** harnessd's worktree roots, and the repositories their worktrees belong to (TH-25). Additive; per process. */
export function guardWorktrees(o: { roots: string[]; repos: string[] }): void {
  for (const r of o.roots) guard.roots.add(real(r));
  for (const r of o.repos) guard.repos.add(path.resolve(r));
}

const guarded = (dir: string) => [...guard.roots].some((r) => dir === r || dir.startsWith(r + path.sep));

/** Whether `admin` (an entry under a shared .git's worktrees/) is `worktree`'s, by its `gitdir` file. */
function adminOf(admin: string, worktree: string): boolean {
  try { return real(path.dirname(fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim())) === worktree; } catch { return false; }
}

/** The admin directory of `worktree` in a guarded repository's shared .git, found without reading the worktree's own `.git`. */
async function adminDirOf(worktree: string): Promise<string> {
  const known = pins.get(worktree);
  if (known && adminOf(known, worktree)) return known;
  for (const repo of guard.repos) {
    let common = commonDirs.get(repo);
    if (!common) {
      try { common = await plainGit(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'); } catch { continue; }
      commonDirs.set(repo, common);
    }
    const dir = path.join(common, 'worktrees');
    const admin = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((n) => path.join(dir, n)).find((a) => adminOf(a, worktree));
    if (admin) {
      pins.set(worktree, admin);
      return admin;
    }
  }
  throw new Error(`refusing to run Git in ${worktree}: it isn't a worktree of a project repository (TH-25)`);
}

async function plainGit(cwd: string, ...args: string[]): Promise<string> {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  const { stdout } = await run('git', [...SAFE, ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.replace(/\n$/, '');
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const dir = real(cwd);
  if (!guarded(dir)) return plainGit(cwd, ...args);
  const admin = await adminDirOf(dir);
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const { stdout } = await run('git', [...SAFE, '--git-dir', admin, '--work-tree', dir, ...args], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.replace(/\n$/, '');
}

export const taskBranch = (taskId: string) => `harness/task/${taskId}`;

/** A new worktree on harness/task/<task-id>, created from an explicit base commit (F-57). */
export async function createWorktree(repo: string, worktree: string, taskId: string, baseSha: string): Promise<{ branch: string }> {
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
  if (!SHA.test(baseSha)) throw new Error(`base must be a full commit SHA, got ${baseSha}`);
  await git(repo, 'cat-file', '-e', `${baseSha}^{commit}`);
  const branch = taskBranch(taskId);
  await git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);
  return { branch };
}

/**
 * Removes the worktree and deletes its branch only if merged (local-runtime §3). Without `force`, Git refuses
 * a worktree with modified or untracked files, so nothing uncommitted is lost; `force` is for an abandoned
 * task only. No repository-wide `worktree prune`: it would drop the human's worktrees on unmounted volumes.
 */
export async function removeWorktree(repo: string, worktree: string, taskId: string, o: { force: boolean }): Promise<{ branchDeleted: boolean }> {
  await git(repo, 'worktree', 'remove', ...(o.force ? ['--force'] : []), worktree);
  let branchDeleted = true;
  try { await git(repo, 'branch', '-d', taskBranch(taskId)); } catch { branchDeleted = false; }
  return { branchDeleted };
}

/**
 * Commits everything in the worktree for the agent. Returns the new commit, or null if nothing changed. The committer
 * is harnessd, unless `committer` is given: in a GitHub project both are the accountable human (D-114).
 */
export async function commitAll(worktree: string, message: string, author: { name: string; email: string }, committer?: { name: string; email: string }): Promise<string | null> {
  await git(worktree, 'add', '-A');
  if (!(await git(worktree, 'diff', '--cached', '--name-only'))) return null;
  const by = committer ?? { name: 'harnessd', email: 'harnessd@harness.invalid' };
  await git(worktree, '-c', `user.name=${by.name}`, '-c', `user.email=${by.email}`, '-c', 'commit.gpgsign=false',
    'commit', '-q', '--no-verify', '--author', `${author.name} <${author.email}>`, '-m', message);
  return git(worktree, 'rev-parse', 'HEAD');
}

/**
 * Paths this task changed: committed since the merge base with the base branch, plus everything
 * uncommitted. Diffing against the merge base means files a sync brought in never count as this
 * agent's edits (D-53). Catches edits no hook saw, such as background writes (D-70).
 */
export async function changedPaths(worktree: string, baseBranch: string): Promise<string[]> {
  const base = await git(worktree, 'merge-base', 'HEAD', baseBranch);
  const committed = (await git(worktree, 'diff', '--no-renames', '--name-only', '-z', base, 'HEAD')).split('\0'); // both paths of a move
  const entries = (await git(worktree, 'status', '--porcelain', '-z', '--untracked-files=all')).split('\0');
  const uncommitted: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.length < 4) continue;
    uncommitted.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') uncommitted.push(entries[++i]!); // renames also name the old path
  }
  return [...new Set([...committed, ...uncommitted].filter(Boolean))].sort();
}

/** The commit a branch points at now. */
export async function branchTip(repo: string, branch: string): Promise<string> {
  return git(repo, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
}

/** The repository's shared Git dir, which every worktree's admin data lives under (F-57). */
export async function gitCommonDir(repo: string): Promise<string> {
  return git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
}
