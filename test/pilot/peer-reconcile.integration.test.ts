// An integrator that sleeps mid-merge is resolved by a peer's reconcile (D-115; acceptance 6). Side A's harnessd is a
// child process: SIGSTOP is A's Mac asleep (no heartbeats, nothing runs), SIGCONT is A waking. The coordinator marks A
// offline; past the threshold, B's harnessd settles A's land from what GitHub shows, read with B's own login, once.
// - GitHub ran A's merge: the land completes (task landed, readers told), and A, waking, adds nothing.
// - Nothing was merged: the land fails and A's reservation is released; A, waking, never asks GitHub to merge again.
// - A peer records a merge that isn't the approved squash: A, waking, checks it itself and deletes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { taskBranch } from '../../packages/daemon/src/git.ts';
import { startPilotStack, type PilotStack } from '../support.ts';

const CHILD = path.resolve(import.meta.dirname, 'harnessd-child.ts');
const SERVER = { offlineAfterMs: 600, reconcileAfterMs: 1500 };
const B = { pollMs: 150, reconcileAfterMs: 1500 };

async function harnessdA(s: PilotStack, children: ChildProcess[], retryMs: number) {
  const proc = spawn(process.execPath, [CHILD], {
    env: { ...process.env, HARNESS_CHILD: JSON.stringify({ home: s.a.home.root, raw: s.a.raw, token: '', pilot: { githubToken: s.fake.token, retryMs } }) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(proc);
  const lines: Record<string, unknown>[] = [];
  let buf = '';
  proc.stdout!.on('data', (d) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  await s.until(() => lines.some((l) => l.ready), 30_000, 'A\'s harnessd to be ready');
  return { proc, logs: () => lines.map((l) => String(l.log ?? '')) };
}
const unsure = async (s: PilotStack) =>
  (await s.db.pool.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND kind = 'land.progress' AND data->>'step' = 'outcome_unknown'", [s.project])).rows[0].n as number;
const rows = async (s: PilotStack, kind: string, task: string) =>
  (await s.db.pool.query("SELECT data FROM events WHERE project_id = $1 AND kind = $2 AND data->>'task_id' = $3 ORDER BY seq", [s.project, kind, task])).rows.map((r) => r.data as Record<string, any>);
const waitFor = async (what: string, pred: () => boolean | Promise<boolean>, ms = 30_000) => {
  for (const end = Date.now() + ms; !(await pred()); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

/** A's task, done, published, and integrated with A's approval; resolves once A has asked GitHub to merge it. */
async function mergeRequested(s: PilotStack, name: string) {
  const agent = (await s.a.command('agent.create', { name, vendor: 'claude' })).agent_id!;
  const task = await s.a.assign(agent, { title: `${name} work`, text: `do ${name}`, scope: [] });
  await waitFor('the session', async () => (await rows(s, 'session.started', task)).length === 1);
  fs.writeFileSync(path.join(s.a.home.worktrees, s.project, task, 'sleepy.txt'), 'work\n');
  await s.a.signed('task.complete', { task_id: task });
  await waitFor('the publish request', () => new Approvals(s.a.home).pending().some((r) => r.kind === 'publish' && r.taskId === task));
  new Approvals(s.a.home).approve(new Approvals(s.a.home).pending().find((r) => r.taskId === task)!.id);
  await waitFor('the PR', async () => (await rows(s, 'pr.published', task)).length === 1);
  const pr = (await s.db.pool.query('SELECT pr_number, head_sha, base_sha FROM task_prs WHERE task_id = $1', [task])).rows[0];
  const received = s.fake.mergesReceived;
  await s.a.integrate(task, { pr_number: pr.pr_number, head_sha: pr.head_sha, base_sha: pr.base_sha });
  await waitFor('A\'s merge request at GitHub', () => s.fake.mergesReceived === received + 1);
  return task;
}

async function withStack(retryMs: number, body: (s: PilotStack, a: Awaited<ReturnType<typeof harnessdA>>) => Promise<void>, b = B) {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, daemons: false, server: SERVER, sideOptions: { b } });
  const children: ChildProcess[] = [];
  try {
    await s.b.daemon.start();
    await s.b.daemon.ready();
    await body(s, await harnessdA(s, children, retryMs));
  } finally {
    for (const c of children) {
      if (c.exitCode !== null || c.signalCode !== null) continue;
      c.kill('SIGCONT');
      c.kill('SIGTERM');
      await new Promise((r) => c.once('exit', r));
    }
    await s.stop();
  }
}

test('A falls asleep after GitHub took its merge request: B settles the land as landed, once, and A, waking, adds nothing', async () => {
  await withStack(100, async (s, a) => {
    s.fake.mergeFault = { delayMs: 300 }; // GitHub merges it a moment later, while A sleeps
    const task = await mergeRequested(s, 'agent/sleepy');
    a.proc.kill('SIGSTOP');
    await waitFor('the merge on GitHub', () => s.fake.prs().some((p) => p.merged));
    await waitFor('B\'s reconcile', async () => (await rows(s, 'land.completed', task)).length === 1, 20_000).catch((e: Error) => { throw new Error(`${e.message}; B: ${s.b.logs.slice(-15).join(' | ')}`); });
    const [done] = await rows(s, 'land.completed', task);
    assert.equal(done!.reconciled_by, 'dev_b');
    assert.equal(done!.new_base_sha, s.fake.prs().find((p) => p.merged)!.mergeCommitSha);
    assert.equal((await s.db.pool.query('SELECT status FROM tasks WHERE id = $1', [task])).rows[0].status, 'landed');
    assert.ok(s.b.logs.some((l) => l.includes(`settled ${task}'s land for dev_a`)));

    a.proc.kill('SIGCONT'); // A wakes: it hears the land is settled, and only tidies up
    const worktree = path.join(s.a.home.worktrees, s.project, task);
    await waitFor('A to tidy up', () => !fs.existsSync(worktree), 20_000);
    await new Promise((r) => setTimeout(r, 800)); // several of A's poll rounds: nothing more happens
    assert.equal((await rows(s, 'land.completed', task)).length, 1, 'one landed event');
    assert.equal(s.fake.mergesReceived, 1, 'one merge request');
  });
});

test('A falls asleep with nothing merged: B releases its reservation, and A, waking, never asks GitHub to merge again', async () => {
  await withStack(3000, async (s, a) => {
    s.fake.mergeFault = 'error5xx'; // nothing merged: A will ask GitHub again after its retry wait
    const task = await mergeRequested(s, 'agent/sleepy2');
    await waitFor('A to be unsure', async () => (await unsure(s)) === 1);
    a.proc.kill('SIGSTOP'); // asleep in its retry wait
    await waitFor('B\'s reconcile', async () => (await rows(s, 'land.failed', task)).length === 1, 20_000).catch((e: Error) => { throw new Error(`${e.message}; B: ${s.b.logs.slice(-15).join(' | ')}`); });
    const [failed] = await rows(s, 'land.failed', task);
    assert.deepEqual([failed!.reason, failed!.reconciled_by], ['interrupted', 'dev_b']);
    assert.match(failed!.detail, /nothing was merged, and the reservation is released/);
    assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM lands WHERE project_id = $1 AND status IN ('requested', 'accepted')", [s.project])).rows[0].n, 0, 'no land holds the project');

    a.proc.kill('SIGCONT');
    await waitFor('A to see it was settled', () => a.logs().some((l) => l.includes('settled while this device was away')), 20_000);
    assert.equal(s.fake.mergesReceived, 1, 'A never asked GitHub to merge again');
    assert.ok(!s.fake.prs().some((p) => p.merged));
    assert.equal((await rows(s, 'land.failed', task)).length, 1);
  });
});

test('a peer records a merge that isn\'t the approved squash: A, waking, checks it itself, and its branch and worktree stay', async () => {
  // B's own harnessd never settles it here: the test speaks for a peer that says "merged, verified" without checking.
  await withStack(3000, async (s, a) => {
    s.fake.mergeFault = 'error5xx'; // A's merge request fails; A will look again after its retry wait
    const task = await mergeRequested(s, 'agent/trusting');
    await waitFor('A to be unsure', async () => (await unsure(s)) === 1);
    // Asleep in its retry wait, not before it: once A has looked at the PR again after the failed merge and fetched
    // the base (its first reconcile round). Stopped any earlier, A could wake with the answer to its outcome_unknown
    // report ahead of the peer's land.completed in its socket, find the land unsettled, and check the merge itself
    // through GitHub instead: as safe (nothing lands, nothing is cleaned up) but a different path from the one this
    // test is about. #133's full-macos run hit exactly that window.
    const prNumber = (await s.db.pool.query('SELECT pr_number FROM task_prs WHERE task_id = $1', [task])).rows[0].pr_number as number;
    await waitFor('A\'s first reconcile round', () => {
      const merged = s.fake.log.findLastIndex((l) => l.server === 'api' && l.method === 'PUT' && l.path.endsWith(`/pulls/${prNumber}/merge`));
      const looked = s.fake.log.findIndex((l, i) => i > merged && l.server === 'api' && l.method === 'GET' && l.path.endsWith(`/pulls/${prNumber}`));
      return looked > 0 && s.fake.log.some((l, i) => i > looked && l.server === 'git' && l.path.includes('git-upload-pack'));
    });
    a.proc.kill('SIGSTOP');
    const land = (await s.db.pool.query('SELECT id, pr_number, approved_head_sha, approved_base_sha FROM lands WHERE task_id = $1', [task])).rows[0];
    s.fake.tamperNextSquash = true;
    const merge = await s.fake.externalMerge(land.pr_number); // merged on GitHub, but not the approved head's tree
    await waitFor('the server to take the peer\'s word, once A is silent', async () => {
      const r = await s.b.daemon.link!.command(s.project, 'land.reconcile', {
        land_id: land.id, pr_number: land.pr_number, observed_head_sha: land.approved_head_sha, observed_base_sha: land.approved_base_sha,
        merged: true, merge_sha: merge, verified: true, changed: [],
      }).catch((e: Error) => { if (/was heard from/.test(e.message)) return null; throw e; });
      return (r?.result as { status?: string } | undefined)?.status === 'completed';
    });

    a.proc.kill('SIGCONT');
    await waitFor('A to check the merge', () => a.logs().some((l) => l.includes(`SECURITY: ${task}'s land was recorded by another device as merged as ${merge.slice(0, 12)}`)), 20_000)
      .catch((e: Error) => { throw new Error(`${e.message}; A's log since it woke: ${a.logs().slice(-25).join(' | ')}`); });
    const worktree = path.join(s.a.home.worktrees, s.project, task);
    assert.equal(fs.readFileSync(path.join(worktree, 'sleepy.txt'), 'utf8'), 'work\n', 'the worktree stays');
    assert.equal(execFileSync('git', ['-C', s.a.repo, 'rev-parse', `refs/heads/${taskBranch(task)}`], { encoding: 'utf8' }).trim(), land.approved_head_sha, 'and its branch');
    assert.equal(s.fake.mergesReceived, 1, 'A never asked GitHub to merge again');
  }, { pollMs: 150, reconcileAfterMs: 600_000 });
});
