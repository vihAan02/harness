import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { changedPaths, commitAll, createWorktree, removeWorktree } from '../src/git.ts';
import { gitIn, makeRepo, tempDir } from './fixtures.ts';

let t: ReturnType<typeof tempDir>;
let repo: string;
let sha: string;
const markers = () => fs.readdirSync(path.join(t.dir, 'markers'));

before(() => {
  t = tempDir('git');
  ({ repo, sha } = makeRepo(t.dir, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' }));
  // Hooks in the shared .git leave a marker if anything runs them. harnessd's Git must never (TH-14).
  fs.mkdirSync(path.join(t.dir, 'markers'));
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'commit-msg']) {
    fs.writeFileSync(path.join(repo, '.git', 'hooks', hook), `#!/bin/sh\ntouch '${path.join(t.dir, 'markers', hook)}'\n`, { mode: 0o755 });
  }
});
after(() => t?.cleanup());

test('a worktree starts at the explicit base commit on harness/task/<id>', async () => {
  const wt = path.join(t.dir, 'wt-1');
  assert.deepEqual(await createWorktree(repo, wt, 'task-1', sha), { branch: 'harness/task/task-1' });
  assert.equal(gitIn(wt, 'rev-parse', 'HEAD'), sha);
  assert.equal(gitIn(wt, 'branch', '--show-current'), 'harness/task/task-1');
  assert.deepEqual(markers(), [], 'a repo hook ran');
});

test('bad task ids and bases are refused before Git runs', async () => {
  await assert.rejects(createWorktree(repo, path.join(t.dir, 'x'), '../evil', sha), /invalid task id/);
  await assert.rejects(createWorktree(repo, path.join(t.dir, 'x'), 'ok', 'main'), /full commit SHA/);
  await assert.rejects(createWorktree(repo, path.join(t.dir, 'x'), 'ok', '0'.repeat(40)));
});

test('harnessd commits as the agent, without running repo hooks', async () => {
  const wt = path.join(t.dir, 'wt-2');
  await createWorktree(repo, wt, 'task-2', sha);
  assert.equal(await commitAll(wt, 'nothing yet', { name: 'agent/a-1', email: 'agent_x@harness.invalid' }), null);
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'changed\n');
  fs.writeFileSync(path.join(wt, 'new.ts'), 'new\n');
  const commit = await commitAll(wt, 'Do the thing', { name: 'agent/a-1', email: 'agent_x@harness.invalid' });
  assert.match(commit!, /^[0-9a-f]{40}$/);
  assert.equal(gitIn(wt, 'log', '-1', '--format=%an <%ae> | %cn | %s'), 'agent/a-1 <agent_x@harness.invalid> | harnessd | Do the thing');
  assert.deepEqual(markers(), [], 'a repo hook ran');
});

test('changed paths diff against the merge base, so a synced base never counts as the agent\'s', async () => {
  const wt = path.join(t.dir, 'wt-3');
  await createWorktree(repo, wt, 'task-3', sha);
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'agent edit\n');
  await commitAll(wt, 'agent', { name: 'agent/a', email: 'a@harness.invalid' });
  fs.writeFileSync(path.join(wt, 'untracked.ts'), 'u\n');
  gitIn(wt, 'mv', 'src/b.ts', 'src/b2.ts');
  // The base moves on with a peer's change, which this worktree then merges in.
  fs.writeFileSync(path.join(repo, 'peer.ts'), 'peer\n');
  gitIn(repo, 'add', 'peer.ts');
  gitIn(repo, 'commit', '-q', '-m', 'peer');
  gitIn(wt, 'stash', '-q', '-u');
  gitIn(wt, 'merge', '-q', '--no-edit', 'main');
  gitIn(wt, 'stash', 'pop', '-q');
  assert.deepEqual(await changedPaths(wt, 'main'), ['src/a.ts', 'src/b.ts', 'src/b2.ts', 'untracked.ts']);
});

test('teardown removes the worktree, and deletes its branch only when merged', async () => {
  const merged = path.join(t.dir, 'wt-4');
  await createWorktree(repo, merged, 'task-4', sha);
  assert.deepEqual(await removeWorktree(repo, merged, 'task-4'), { branchDeleted: true }); // nothing new on it
  const unmerged = path.join(t.dir, 'wt-5');
  await createWorktree(repo, unmerged, 'task-5', sha);
  fs.writeFileSync(path.join(unmerged, 'work.ts'), 'w\n');
  await commitAll(unmerged, 'work', { name: 'agent/a', email: 'a@harness.invalid' });
  assert.deepEqual(await removeWorktree(repo, unmerged, 'task-5'), { branchDeleted: false });
  assert.equal(fs.existsSync(unmerged), false);
  assert.match(gitIn(repo, 'branch', '--list', 'harness/task/task-5'), /task-5/);
  assert.deepEqual(markers(), []);
});
