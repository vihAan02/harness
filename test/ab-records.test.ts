// What the A/B runners record must be the same in both arms (validation.md §2 "held constant", §9). These pin
// the fixes from the reviews of #79 and #81: the baseline's files sit where its read confinement keeps the other
// agent out, an unfinished harness task's work reaches its diffs, `sync --theirs` names exactly the files that
// conflicted, a `.first` tree is never silently missing, and a compaction summary isn't a human prompt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAllowed } from '../packages/adapters/src/readpolicy.ts';
import { readPolicyFor } from '../packages/daemon/src/readpolicy.ts';
import { gitIn, makeRepo, tempDir, tempHome } from '../packages/daemon/test/fixtures.ts';
import { baselinePaths, conflictedPaths, syncTheirs } from '../scripts/ab/baseline-arm.ts';
import { finalCommits, mergeTree, writeDiffs } from '../scripts/ab/summarize.ts';
import { readTranscript } from '../scripts/ab/transcripts.ts';

const t = tempDir('ab-records');
after(() => t.cleanup());
const author = { name: 'Coordinator', email: 'coordinator@harness.invalid' };

test('a baseline agent can read its own worktree, but not the other agent\'s worktree, card or integration worktrees (D-98)', () => {
  const root = path.join(t.dir, 'confinement');
  const { repo } = makeRepo(root, { 'a.txt': 'a\n' });
  const home = tempHome(root);
  const [a, b] = [baselinePaths(home, 'backend'), baselinePaths(home, 'frontend')];
  for (const p of [a.worktree, b.worktree, path.dirname(b.card), b.integration(1)]) fs.mkdirSync(p, { recursive: true });
  for (const f of [path.join(a.worktree, 'x.ts'), path.join(b.worktree, 'y.ts'), b.card, path.join(b.integration(1), 'z.ts')]) fs.writeFileSync(f, '');
  const policy = readPolicyFor({
    home: os.homedir(), harnessRoot: home.root, repo, worktree: a.worktree, gitCommonDir: path.join(repo, '.git'),
    readAllow: [], pathEnv: '', tmpdir: os.tmpdir(), env: {},
  });
  assert.equal(readAllowed(policy, path.join(a.worktree, 'x.ts'), a.worktree), true, 'its own worktree');
  assert.equal(readAllowed(policy, path.join(b.worktree, 'y.ts'), a.worktree), false, 'the other agent\'s worktree');
  assert.equal(readAllowed(policy, b.card, a.worktree), false, 'the other agent\'s card');
  assert.equal(readAllowed(policy, path.join(b.integration(1), 'z.ts'), a.worktree), false, 'an integration worktree');
  // Negative control: the run's temp root itself isn't denied, so the old layout (worktrees beside the harness
  // home) let one agent read the other's work in progress.
  const old = path.join(root, 'worktrees', 'frontend');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'y.ts'), '');
  assert.equal(readAllowed(policy, path.join(old, 'y.ts'), a.worktree), true);
});

test('an unfinished task\'s work is committed and diffed from its branch tip; a landed task keeps its last commit', async () => {
  const root = path.join(t.dir, 'final-commits');
  const { repo, sha } = makeRepo(root, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const wt = path.join(root, 'wt-1');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'harness/task/T-1', wt, sha);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a, half done\n'); // left uncommitted at the cap
  const landed = 'c'.repeat(40);
  const commits = await finalCommits(repo, [
    { key: 'T1', branch: 'harness/task/T-1', worktree: wt, committed: null },
    { key: 'T2', branch: 'harness/task/T-2', worktree: path.join(root, 'gone'), committed: landed }, // landed: branch deleted
    { key: 'T3', branch: null, worktree: null, committed: null }, // never started
  ], author);
  assert.equal(commits[0]!.commit, gitIn(repo, 'rev-parse', 'harness/task/T-1'));
  assert.notEqual(commits[0]!.commit, sha, 'the leftover work was committed');
  assert.deepEqual(commits.slice(1), [{ key: 'T2', commit: landed }, { key: 'T3', commit: null }]);
  writeDiffs(path.join(root, 'record'), repo, sha, sha, [commits[0]!]);
  const patch = fs.readFileSync(path.join(root, 'record', 'diffs', 'T1.patch'), 'utf8');
  assert.match(patch, /^\+a, half done$/m, 'the judge and M3 see what the capped task did');
  // Negative control: the last `worktree.committed` alone (null for a task never done) gives an empty patch.
  writeDiffs(path.join(root, 'record-old'), repo, sha, sha, [{ key: 'T1', commit: null }]);
  assert.equal(fs.readFileSync(path.join(root, 'record-old', 'diffs', 'T1.patch'), 'utf8'), '');
});

test('sync --theirs names exactly the files that conflicted, not every file both sides touched (§9 step 7)', async () => {
  const root = path.join(t.dir, 'theirs');
  const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';
  const { repo, sha } = makeRepo(root, { 'a.txt': lines(3), 'b.txt': lines(20) });
  const wt = path.join(root, 'agent-wt');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'agent', wt, sha);
  fs.writeFileSync(path.join(wt, 'a.txt'), lines(3, { 1: 'ONE (agent)' }));
  fs.writeFileSync(path.join(wt, 'b.txt'), lines(20, { 1: 'b1 (agent)' }));
  gitIn(repo, 'switch', '-q', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), lines(3, { 1: 'ONE (main)' }));
  fs.writeFileSync(path.join(repo, 'b.txt'), lines(20, { 20: 'b20 (main)' })); // both changed b.txt, far apart: no conflict
  gitIn(repo, 'commit', '-q', '-am', 'main: a1, b20');
  const main = gitIn(repo, 'rev-parse', 'main');
  assert.deepEqual(conflictedPaths(wt, main), [], 'the work in progress isn\'t committed yet, so HEAD is the base: nothing conflicts');
  const r = await syncTheirs(wt, main, author);
  assert.deepEqual(r, { replaced: ['a.txt'] }, 'b.txt merged cleanly, so nothing of the agent\'s was replaced there');
  assert.equal(fs.readFileSync(path.join(wt, 'b.txt'), 'utf8'), lines(20, { 1: 'b1 (agent)', 20: 'b20 (main)' }));
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), lines(3, { 1: 'ONE (main)' }), 'main\'s side won the conflict');
  assert.deepEqual(await syncTheirs(wt, main, author), { replaced: [] }, 'already up to date');
  assert.throws(() => conflictedPaths(wt, 'f'.repeat(40)), 'an unknown commit is an error, never "no conflicts"');
});

test('mergeTree: a conflict gives no tree, but any other failure throws instead of passing for one', () => {
  const root = path.join(t.dir, 'merge-tree-errors');
  const { repo, sha } = makeRepo(root, { 'a.txt': 'a\n' });
  const commit = (branch: string, text: string) => {
    gitIn(repo, 'switch', '-q', '-C', branch, sha);
    fs.writeFileSync(path.join(repo, 'a.txt'), text);
    gitIn(repo, 'commit', '-q', '-am', branch);
    return gitIn(repo, 'rev-parse', 'HEAD');
  };
  assert.equal(mergeTree(repo, commit('x', 'x\n'), commit('y', 'y\n')), null);
  assert.throws(() => mergeTree(repo, sha, 'f'.repeat(40)), 'a missing commit is an error, not a conflict');
});

test('a compaction\'s summary in a CLI transcript isn\'t a human prompt (baseline M5, M7)', () => {
  const entry = (o: Record<string, unknown>) => JSON.stringify({ type: 'user', timestamp: '2026-10-07T10:00:00.000Z', ...o });
  const facts = readTranscript([
    entry({ message: { role: 'user', content: 'Build the login endpoint.' } }),
    entry({ isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: …' } }),
    entry({ message: { role: 'user', content: [{ type: 'text', text: 'The backend changed POST /login to return { session }.' }] } }),
  ]);
  assert.deepEqual(facts.prompts.map((p) => p.chars), ['Build the login endpoint.'.length, 'The backend changed POST /login to return { session }.'.length]);
});
