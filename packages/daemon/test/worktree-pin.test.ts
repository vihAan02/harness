// A redirected worktree (TH-25, D-114): the agent rewrites its worktree's `.git` to point at a repository it made,
// whose config defines a clean filter. Git that follows the `.git` file runs that filter on the host when harnessd
// stages the agent's work. harnessd's Git is pinned to the worktree's admin directory in the main repository's
// shared .git, so it never reads the agent's config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { commitAll, createWorktree, git, guardWorktrees, taskBranch } from '../src/git.ts';
import { ignoredPaths } from '../src/reads.ts';
import { gitIn, makeRepo, tempDir } from './fixtures.ts';

/** A task worktree under a guarded root, and a repository the "agent" made inside it, with a filter that leaves a marker. */
function redirected() {
  const t = tempDir('pin');
  const { repo, sha } = makeRepo(t.dir, { 'a.txt': 'a\n' });
  const root = path.join(t.dir, 'worktrees');
  const marker = path.join(t.dir, 'pwned');
  return { t, repo, sha, root, marker, async worktree(task: string) {
    const wt = path.join(root, task);
    await createWorktree(repo, wt, task, sha);
    // The agent's own repository (anywhere it can write), with a clean filter on every file.
    const evil = path.join(t.dir, `evil-${task}`);
    gitIn(t.dir, 'init', '-q', evil);
    gitIn(evil, 'config', 'filter.pwn.clean', `sh -c 'touch ${marker}; cat'`);
    fs.writeFileSync(path.join(wt, '.gitattributes'), '* filter=pwn\n');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'changed by the agent\n');
    return { wt, evil };
  } };
}

test('a rewritten .git file: Git that follows it runs the agent\'s filter; harnessd\'s pinned Git doesn\'t, and commits to the real branch', async () => {
  const r = redirected();
  try {
    guardWorktrees({ roots: [r.root], repos: [r.repo] });
    const { wt, evil } = await r.worktree('T-1');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(evil, '.git')}\n`);
    // The positive control: plain Git in the worktree follows the file, and the filter runs on the host.
    execFileSync('git', ['add', '-A'], { cwd: wt, stdio: 'ignore' });
    assert.ok(fs.existsSync(r.marker), 'the attack works against unpinned Git');
    fs.rmSync(r.marker);
    execFileSync('git', ['reset', '-q'], { cwd: wt });
    // harnessd's Git: pinned, so the agent's config is never read.
    const sha = await commitAll(wt, 'work', { name: 'agent', email: 'agent@harness.invalid' });
    assert.ok(!fs.existsSync(r.marker), 'the agent\'s filter never ran');
    assert.equal(gitIn(r.repo, 'rev-parse', taskBranch('T-1')), sha, 'the commit is on the task branch in the real repository');
    assert.equal(gitIn(r.repo, 'show', `${sha}:a.txt`), 'changed by the agent');
  } finally { r.t.cleanup(); }
});

test('a .git replaced by a directory, and a directory that isn\'t a worktree: still pinned, or refused', async () => {
  const r = redirected();
  try {
    guardWorktrees({ roots: [r.root], repos: [r.repo] });
    const { wt, evil } = await r.worktree('T-2');
    fs.rmSync(path.join(wt, '.git'));
    fs.renameSync(path.join(evil, '.git'), path.join(wt, '.git')); // the agent's repository is now the worktree's .git
    const sha = await commitAll(wt, 'work', { name: 'agent', email: 'agent@harness.invalid' });
    assert.ok(!fs.existsSync(r.marker), 'the agent\'s filter never ran');
    assert.equal(gitIn(r.repo, 'rev-parse', taskBranch('T-2')), sha);
    // Under a guarded root, a directory with no admin entry in the project's repository is refused, not trusted.
    const stray = path.join(r.root, 'T-3');
    fs.mkdirSync(stray);
    gitIn(stray, 'init', '-q');
    await assert.rejects(git(stray, 'status'), /isn't a worktree of a project repository \(TH-25\)/);
    // Outside the guarded roots (the human's own checkout), Git is as before.
    assert.equal(await git(r.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  } finally { r.t.cleanup(); }
});

test('which reads Git ignores is asked of the pinned repository, never one the agent made, so a read can\'t be hidden (#103)', async () => {
  const r = redirected();
  try {
    guardWorktrees({ roots: [r.root], repos: [r.repo] });
    const { wt, evil } = await r.worktree('T-5');
    fs.writeFileSync(path.join(evil, '.git', 'info', 'exclude'), 'secret.txt\n');
    fs.writeFileSync(path.join(wt, 'secret.txt'), 'read by the agent\n');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(evil, '.git')}\n`);
    // The positive control: plain Git follows the file, and the agent's exclude hides the read.
    assert.equal(execFileSync('git', ['check-ignore', 'secret.txt'], { cwd: wt, encoding: 'utf8' }).trim(), 'secret.txt');
    assert.deepEqual([...await ignoredPaths(wt, ['secret.txt', 'a.txt'])], [], 'harnessd\'s pinned Git ignores neither');
  } finally { r.t.cleanup(); }
});
