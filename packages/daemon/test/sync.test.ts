// Sync at turn end (D-53): work in progress committed as the agent, the new base merged in by commit id,
// the diff base advanced, and a conflict left exactly as the agent had it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { changedPaths, createWorktree } from '../src/git.ts';
import { contains, syncWorktree } from '../src/sync.ts';
import { gitIn, makeRepo, tempDir } from './fixtures.ts';

const AGENT = { name: 'agent/frontend', email: 'agent_f@harness.invalid' };

async function scenario() {
  const t = tempDir('sync');
  const { repo, sha } = makeRepo(t.dir, { 'src/types.ts': 'export type User = { id: string };\n', 'src/views.ts': 'export const v = 1;\n' });
  const wt = path.join(t.dir, 'wt-T-1');
  await createWorktree(repo, wt, 'T-1', sha);
  // The peer's change lands on main.
  fs.writeFileSync(path.join(repo, 'src/types.ts'), 'export type User = { id: string; email: string };\n');
  gitIn(repo, 'commit', '-qam', 'peer: add email');
  return { t, repo, sha, wt, landed: gitIn(repo, 'rev-parse', 'main') };
}

test('a sync commits the agent\'s work in progress, merges the landed base, and advances the diff base', async () => {
  const { t, repo, sha, wt, landed } = await scenario();
  fs.writeFileSync(path.join(wt, 'src/views.ts'), 'export const v = 2;\n'); // uncommitted agent work
  const r = await syncWorktree({ worktree: wt, target: landed, taskId: 'T-1', agent: AGENT });
  assert.ok(r.ok);
  assert.equal(r.oldBase, sha);
  assert.deepEqual(r.changed, ['src/types.ts']);
  assert.ok(r.wip);
  assert.equal(gitIn(wt, 'log', '-1', '--format=%an', r.wip!), 'agent/frontend', 'the WIP commit is the agent\'s work');
  assert.equal(gitIn(wt, 'log', '-1', '--format=%cn', r.merge!), 'harnessd', 'the merge is harnessd\'s');
  assert.match(fs.readFileSync(path.join(wt, 'src/types.ts'), 'utf8'), /email/, 'the agent can now read the landed content');
  assert.ok(await contains(wt, landed));
  // Negative control for the diff base: against the old base, the peer's file would count as the agent's edit.
  assert.deepEqual(await changedPaths(wt, 'main'), ['src/views.ts'], 'only the agent\'s own file is its observed claim');
  assert.ok(gitIn(wt, 'diff', '--name-only', sha, 'HEAD').includes('src/types.ts'));
  // Already up to date: a no-op.
  const again = await syncWorktree({ worktree: wt, target: landed, taskId: 'T-1', agent: AGENT });
  assert.deepEqual(again.ok && [again.merge, again.changed], [null, []]);
  void repo;
  t.cleanup();
});

test('a conflicting sync is aborted: the worktree is exactly as the agent had it, and the paths are returned', async () => {
  const { t, wt, landed } = await scenario();
  fs.writeFileSync(path.join(wt, 'src/types.ts'), 'export type User = { id: number };\n');
  const r = await syncWorktree({ worktree: wt, target: landed, taskId: 'T-1', agent: AGENT });
  assert.equal(r.ok, false);
  assert.deepEqual(!r.ok && r.conflicts, ['src/types.ts']);
  assert.equal(fs.readFileSync(path.join(wt, 'src/types.ts'), 'utf8'), 'export type User = { id: number };\n');
  assert.equal(gitIn(wt, 'status', '--porcelain'), '', 'the agent\'s work is safe in its WIP commit');
  assert.ok(!(await contains(wt, landed)));
  t.cleanup();
});
