// The integration reservation (D-115, acceptance 4): the human approves one exact head on one exact base; harnessd
// fences, arms, merges that head through GitHub as a squash, verifies it, and lands it once. Stale tokens, a moved head
// or base, missing reviews or a busy CI refuse it before any merge request; while it's held, no other task gets an
// overlapping lease, force or not; an ambiguous answer is reconciled from GitHub, never released by a timer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { startPilotStack, type PilotStack } from '../support.ts';
import type { MergeFault } from '../fake-github.ts';

const FAST = { pollMs: 150, github: { token: async () => '', retryMs: 100 } };

/** Human A's task, done, published and its PR open; returns the PR. */
async function published(s: PilotStack, name: string, file = `${name.replace('/', '-')}.txt`) {
  const agent = (await s.a.command('agent.create', { name, vendor: 'claude' })).agent_id!;
  const task = await s.a.assign(agent, { title: `${name} work`, text: `do ${name}`, scope: [] });
  await s.until(() => s.a.daemon.running.has(task), 20_000, `${task}'s session`);
  const target = path.join(s.a.daemon.worktreeOf(s.project, task), file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${name}\n`);
  await s.a.signed('task.complete', { task_id: task });
  await s.until(() => new Approvals(s.a.home).pending().some((r) => r.kind === 'publish' && r.taskId === task), 20_000, 'the publish request');
  new Approvals(s.a.home).approve(new Approvals(s.a.home).pending().find((r) => r.taskId === task)!.id);
  await s.until(() => s.a.daemon.view(s.project).prs.has(task), 20_000, 'the PR');
  const pr = s.a.daemon.view(s.project).prs.get(task)!;
  return { task, agent, pr, file };
}
/** The human approves the PR's exact head on the current base (`harness integrate`). */
const integrate = async (s: PilotStack, t: Awaited<ReturnType<typeof published>>, over: Record<string, unknown> = {}) =>
  (await s.a.command('land.request', { task_id: t.task, mode: 'github', pr_number: t.pr.prNumber, head_sha: t.pr.headSha, base_sha: t.pr.baseSha, ...over })).land_id!;
const landOf = (s: PilotStack, id: string) => s.b.daemon.view(s.project).lands.get(id);
const merges = (s: PilotStack) => s.fake.log.filter((l) => l.method === 'PUT' && l.path.endsWith('/merge'));
const count = async (s: PilotStack, kind: string) => (await s.db.pool.query('SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND kind = $2', [s.project, kind])).rows[0].n as number;

async function stack(o: { files?: Record<string, string>; fake?: Record<string, unknown> } = {}) {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n', ...o.files }, daemonOptions: FAST, ...(o.fake ? { fake: o.fake } : {}) });
  // The fake's token for both sides (the stack sets it; FAST's placeholder must not replace it).
  for (const side of [s.a, s.b]) side.daemon.o.github = { token: async () => s.fake.token, retryMs: 100 };
  return s;
}

test('the approved head merges as a squash on the approved base, is verified, lands once, and its branch and worktree go', async () => {
  const s = await stack();
  try {
    const t = await published(s, 'agent/ok');
    const base = await s.fake.baseTip();
    const land = await integrate(s, t);
    await s.until(() => landOf(s, land)?.status === 'completed', 20_000, 'the land');
    const merge = await s.fake.baseTip();
    assert.notEqual(merge, base);
    assert.equal(landOf(s, land)!.newBaseSha, merge);
    assert.equal((await s.fake.git(['rev-parse', `${merge}^1`])), base, 'parent: the approved base');
    assert.equal(await s.fake.git(['rev-parse', `${merge}^{tree}`]), await s.fake.git(['rev-parse', `${t.pr.headSha}^{tree}`]), 'tree: the approved head\'s');
    assert.equal(merges(s).length, 1);
    assert.equal(await count(s, 'land.completed'), 1);
    assert.equal(s.a.daemon.view(s.project).tasks.get(t.task)!.status, 'landed');
    // The cleanup follows the land: the worktree, then the branch (by compare-and-swap).
    await s.until(() => !fs.existsSync(s.a.daemon.worktreeOf(s.project, t.task)), 10_000, 'the worktree to go');
    const branch = () => s.fake.git(['rev-parse', '--verify', '--quiet', 'refs/heads/harness/task/' + t.task], { cwd: s.a.repo }).catch(() => '');
    for (const end = Date.now() + 10_000; await branch(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) assert.fail('the local branch went');
    assert.equal((await s.db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [s.project])).rows[0].tip_sha, merge);
    // Polling later finds the merge already known: no second land, no outside-move notice.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await count(s, 'land.completed'), 1);
    assert.equal(await count(s, 'base.advanced'), 0);
  } finally { await s.stop(); }
});

test('refused before any merge request: a moved head, a moved base, a stale fencing token, a missing review', async () => {
  const s = await stack({ files: { '.github/CODEOWNERS': '/reviewed/  @vihAan02\n' } });
  try {
    // The approval names a head the PR doesn't have: the server refuses the request itself.
    const t1 = await published(s, 'agent/h1');
    await assert.rejects(integrate(s, t1, { head_sha: 'f'.repeat(40) }), /approve the head it has/);
    // The PR's head moves after the approval (someone pushed to it): head_changed, nothing armed.
    const moved = await s.fake.git(['commit-tree', `${t1.pr.headSha}^{tree}`, '-p', t1.pr.headSha, '-m', 'pushed after approval']);
    await s.fake.git(['update-ref', `refs/heads/${s.a.daemon.remoteBranch(s.project, t1.task)}`, moved]);
    const l1 = await integrate(s, t1);
    await s.until(() => landOf(s, l1)?.status === 'failed', 20_000, 'head_changed');
    assert.equal(landOf(s, l1)!.reason, 'head_changed');
    // A missing review CODEOWNERS requires (another human's files): review_required.
    const t2 = await published(s, 'agent/r2', 'reviewed/x.txt');
    const l2 = await integrate(s, t2);
    await s.until(() => landOf(s, l2)?.status === 'failed', 20_000, 'review_required');
    assert.equal(landOf(s, l2)!.reason, 'review_required');
    s.fake.addReview(t2.pr.prNumber, { login: 'vihAan02', state: 'APPROVED', commit_id: t2.pr.headSha });
    const l2b = await integrate(s, t2);
    await s.until(() => landOf(s, l2b)?.status === 'completed', 20_000, 'landed once reviewed');
    // The base moves after the approval: base_moved.
    const t3 = await published(s, 'agent/b3');
    await s.fake.pushToBase({ 'other.txt': 'x\n' }, 'a human merges something');
    const l3 = await integrate(s, t3);
    await s.until(() => landOf(s, l3)?.status === 'failed', 20_000, 'base_moved');
    assert.match(landOf(s, l3)!.reason!, /base_moved|head_behind/);
    // A newer overlapping token: the stale candidate is refused at the fencing check, before any merge request.
    const t4 = await published(s, 'agent/f4', 'fenced.txt');
    const token = Number((await s.db.pool.query('UPDATE projects SET next_fencing_token = next_fencing_token + 2 WHERE id = $1 RETURNING next_fencing_token', [s.project])).rows[0].next_fencing_token);
    const other = (await s.db.pool.query("SELECT id FROM tasks WHERE project_id = $1 AND id <> $2 LIMIT 1", [s.project, t4.task])).rows[0].id;
    await s.db.pool.query("INSERT INTO leases (id, project_id, task_id, path, token, expires_at) VALUES ('ls_mine0000000000', $1, $2, 'fenced.txt', $3, now() - interval '1 minute'), ('ls_newr0000000000', $1, $4, 'fenced.txt', $5, now() - interval '1 minute')",
      [s.project, t4.task, token - 1, other, token]);
    const before = merges(s).length;
    const l4 = await integrate(s, t4);
    await s.until(() => landOf(s, l4)?.status === 'rejected', 20_000, 'the fencing refusal');
    assert.equal(merges(s).length, before, 'no merge request for a stale candidate');
  } finally { await s.stop(); }
});

for (const [fault, what] of [['drop', 'merged, but the answer was lost'], ['error5xx', 'a 502, nothing merged']] as [MergeFault, string][]) {
  test(`an ambiguous answer (${what}) is reconciled from GitHub: one merge, one landed event`, async () => {
    const s = await stack();
    try {
      const t = await published(s, `agent/${fault}`);
      s.fake.mergeFault = fault;
      const land = await integrate(s, t);
      await s.until(() => landOf(s, land)?.status === 'completed', 30_000, 'the land after reconciling');
      assert.equal(await count(s, 'land.completed'), 1);
      assert.equal(s.fake.prs().filter((p) => p.merged).length, 1);
      assert.ok(s.b.daemon.view(s.project).events.some((e) => e.kind === 'land.progress' && (e.data as { step?: string }).step === 'outcome_unknown'), 'it said outcome_unknown');
      assert.equal(merges(s).length, fault === 'drop' ? 1 : 2, fault === 'drop' ? 'never merged twice' : 're-armed and asked again');
    } finally { await s.stop(); }
  });
}

test('while the reservation is held, no other task gets an overlapping lease, force or not; once landed, it can', async () => {
  const s = await stack();
  try {
    const t = await published(s, 'agent/held', 'shared.txt');
    const otherAgent = (await s.b.command('agent.create', { name: 'agent/other', vendor: 'claude' })).agent_id!;
    const other = await s.b.assign(otherAgent, { title: 'other', text: 'other', scope: [] });
    await s.until(() => s.b.daemon.running.has(other), 20_000, 'the other session');
    s.fake.mergeFault = { delayMs: 1500 }; // the merge takes a while: the reservation is held meanwhile
    const land = await integrate(s, t);
    await s.until(() => landOf(s, land)?.step === 'merge_requested', 20_000, 'armed');
    await assert.rejects(s.b.command('lease.acquire', { task_id: other, paths: ['shared.txt'], force: true }), /reserved by the integration/);
    await assert.rejects(s.a.command('land.cancel', { task_id: t.task }), /can't be cancelled/);
    await s.until(() => landOf(s, land)?.status === 'completed', 20_000, 'the land');
    const r = await s.b.command('lease.acquire', { task_id: other, paths: ['shared.txt'] });
    assert.equal((r.granted as unknown as unknown[]).length, 1);
  } finally { await s.stop(); }
});

test('the base moves between the reservation and the arm: the arm is refused and nothing is merged', async () => {
  let moveBase: (() => Promise<void>) | null = null;
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, daemonOptions: { ...FAST, faults: { beforeArm: () => moveBase!() } } });
  try {
    for (const side of [s.a, s.b]) side.daemon.o.github = { token: async () => s.fake.token, retryMs: 100 };
    moveBase = async () => {
      const moved = await s.fake.pushToBase({ 'race.txt': 'x\n' }, 'an outside merge, mid-reservation');
      await s.until(() => s.b.daemon.view(s.project).baseAdvances.some((b) => b.newSha === moved), 20_000, 'the coordinator to see the move');
    };
    const t = await published(s, 'agent/race');
    const land = await integrate(s, t);
    await s.until(() => ['failed', 'completed'].includes(landOf(s, land)?.status ?? ''), 20_000, 'the outcome');
    assert.equal(landOf(s, land)!.status, 'failed');
    assert.equal(landOf(s, land)!.reason, 'base_moved');
    assert.equal(merges(s).length, 0, 'no merge request');
    assert.equal(s.fake.prs()[0]!.merged, false);
  } finally { await s.stop(); }
});

test('a failure while completing after the merge is reconciled, not left armed: one land, once', async () => {
  const s = await stack();
  try {
    const t = await published(s, 'agent/flaky');
    // The first attempt to move the base ref after the merge fails (as a fetch racing on the ref lock did).
    const real = s.a.daemon.advanceProjectBase.bind(s.a.daemon);
    let failures = 1;
    s.a.daemon.advanceProjectBase = async (...args: Parameters<typeof real>) => {
      if (failures-- > 0) throw new Error('injected: cannot lock ref');
      return real(...args);
    };
    const land = await integrate(s, t);
    await s.until(() => landOf(s, land)?.status === 'completed', 20_000, 'the land, after reconciling');
    assert.ok(failures < 0, 'the first completion failed and a retry went through');
    assert.equal(merges(s).length, 1, 'merged once');
    assert.equal(await count(s, 'land.completed'), 1);
  } finally { await s.stop(); }
});
