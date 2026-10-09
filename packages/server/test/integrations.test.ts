// GitHub integration records on the server (D-114, D-115; protocol.md §11): a task's PR and what its device polls
// of it, blocked publishes, the base branch's tip moved only by compare-and-swap, merges made outside the harness
// noticed once, and the local land refused in a GitHub project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, parsePrivateKey } from '@harness/protocol/signing';
import { executeCommand, CommandError } from '../src/commands.ts';
import { dispatchFor, freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
let local: string;
const human = { principal: 'human_test', deviceId: null };
const device = { principal: 'human_test', deviceId: 'dev_1' };
const other = { principal: 'human_test', deviceId: 'dev_2' };
/** The human's CLI on dev_1, with its device key (D-111): its lifecycle commands carry dispatches it signed (D-112). */
const owner = { principal: 'human_test', deviceId: 'dev_1', authDeviceId: 'dev_1' };
const key1 = generateKeyPair();
const cmd = (projectId: string, name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: projectId, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>, caller: { principal: string; deviceId: string | null } = human, p = project) => executeCommand(db.pool, caller, cmd(p, name, args));
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code && (!re || re.test(e.message)));
const SHA = (c: string) => c.repeat(40);
const kinds = async (seqs: number[]) => (await db.pool.query('SELECT kind, data FROM events WHERE seq = ANY($1) AND project_id = $2 ORDER BY seq', [seqs, project])).rows;

/** A task its agent ran on dev_1 and finished. In the GitHub project the human acts from dev_1, with signed dispatches. */
async function finished(name: string, p = project) {
  const github = p === project;
  const caller = github ? owner : human;
  const signed = async (kind: 'start' | 'complete', task: string, agent: string) => github
    ? { dispatch: await dispatchFor(db.pool, parsePrivateKey(key1.privateKeyPem), { kind, projectId: p, taskId: task, agentId: agent, targetDevice: 'dev_1', issuerHuman: 'human_test', issuerDevice: 'dev_1' }) }
    : {};
  const agent = res(await run('agent.create', { name, vendor: 'claude' }, caller, p)).agent_id as string;
  const task = res(await run('task.create', { title: name, text: name, scope: [] }, caller, p)).task_id as string;
  await run('task.assign', { task_id: task, assignee_agent_id: agent, ...await signed('start', task, agent) }, caller, p);
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd(p, 'session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `b/${task}` }, agent));
  const read = (path: string, hash: string | null) => executeCommand(db.pool, device, cmd(p, 'readset.add', { session_id: session, entries: [{ path, hash, source: 'read_tool', confidence: 'high' }] }, agent));
  return { agent, task, session, read, complete: async () => run('task.complete', { task_id: task, ...await signed('complete', task, agent) }, caller, p) };
}
const publish = (task: string, n: number, head = SHA('2'), caller = device) =>
  run('pr.publish', { task_id: task, pr_number: n, url: `https://github.com/o/r/pull/${n}`, head_sha: head, base_sha: SHA('1'), remote_ref: `refs/heads/harness/p/e/${task}` }, caller);
const status = (task: string, n: number, over: Record<string, unknown> = {}) =>
  run('pr.status', { task_id: task, pr_number: n, head_sha: SHA('2'), state: 'open', merged: false, mergeable_state: 'clean', checks: { guard: 'success' }, reviews: [], ...over }, device);

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  local = await seedProject(db.pool);
  await db.pool.query("UPDATE projects SET integration_mode = 'github', github_repo = 'o/r' WHERE id = $1", [project]);
  await db.pool.query("INSERT INTO devices (id, human_id, name, public_key) VALUES ('dev_1', 'human_test', 'laptop', $1), ('dev_2', 'human_test', 'other', NULL)", [key1.publicKey]);
});
after(async () => { await db?.drop(); });

test('a task\'s PR: published by the device that ran it, once it\'s done; polled status is recorded only when it changes', async () => {
  const w = await finished('agent/p1');
  await rejects(publish(w.task, 7), 'conflict', /only a finished task/);
  await w.complete();
  await rejects(publish(w.task, 7, SHA('2'), other), 'forbidden', /another device/);
  await rejects(run('pr.publish', { task_id: w.task, pr_number: 7, url: 'x', head_sha: SHA('2'), base_sha: SHA('1'), remote_ref: 'refs/heads/b' }), 'forbidden', /only harnessd/);
  await rejects(run('pr.publish', { task_id: w.task, pr_number: 0, url: 'https://x', head_sha: SHA('2'), base_sha: SHA('1'), remote_ref: 'refs/heads/b' }, device), 'bad_request');
  await rejects(run('pr.publish', { task_id: w.task, pr_number: 7, url: 'https://x', head_sha: SHA('2'), base_sha: SHA('1'), remote_ref: 'main' }, device), 'bad_request', /remote_ref/);
  const p = await publish(w.task, 7);
  assert.deepEqual((await kinds(p.seqs)).map((e) => e.kind), ['pr.published']);
  const s1 = await status(w.task, 7);
  assert.deepEqual((await kinds(s1.seqs)).map((e) => e.kind), ['pr.updated']);
  const same = await status(w.task, 7);
  assert.deepEqual(same.seqs, [], 'nothing changed: no event');
  assert.equal(res(same).changed, false);
  const pushed = await status(w.task, 7, { head_sha: SHA('4'), mergeable_state: 'behind' });
  assert.equal((await kinds(pushed.seqs))[0].data.head_sha, SHA('4'));
  await rejects(status(w.task, 8), 'conflict', /#7/);
  await rejects(status(w.task, 7, { checks: { guard: 'green' } }), 'bad_request', /conclusion/);
  await rejects(status(w.task, 7, { merged: true }), 'bad_request', /merge_sha/);
  await rejects(run('pr.status', { task_id: w.task, pr_number: 7, head_sha: SHA('2'), state: 'open', merged: false, mergeable_state: 'clean', checks: {}, reviews: [] }, other), 'forbidden');
  const row = (await db.pool.query('SELECT head_sha, mergeable_state, checks FROM task_prs WHERE task_id = $1', [w.task])).rows[0];
  assert.deepEqual(row, { head_sha: SHA('4'), mergeable_state: 'behind', checks: { guard: 'success' } });
});

test('a blocked publish is recorded for the human; nothing else changes', async () => {
  const w = await finished('agent/b1');
  await w.complete();
  const r = await run('publish.blocked', { task_id: w.task, reasons: [{ rule: 'denied_path', path: '.github/workflows/ci.yml' }, { rule: 'secret:sk-or-', commit: SHA('5') }] }, device);
  const [e] = await kinds(r.seqs);
  assert.equal(e.kind, 'publish.blocked');
  assert.deepEqual(e.data.reasons, [{ rule: 'denied_path', path: '.github/workflows/ci.yml' }, { rule: 'secret:sk-or-', commit: SHA('5') }]);
  await rejects(run('publish.blocked', { task_id: w.task, reasons: [] }, device), 'bad_request');
});

test('the base chain: the first observation seeds it, then only a compare-and-swap moves it; a move is noticed once', async () => {
  const reader = await finished('agent/r1');
  await reader.read('src/shared.ts', SHA('a'));
  await reader.read('src/same.ts', SHA('b'));
  await db.pool.query('UPDATE tasks SET base_set_at = now() WHERE id = $1', [reader.task]);
  const seed = await run('base.observe', { old_sha: SHA('0'), new_sha: SHA('1'), changed: [] }, device);
  assert.equal(res(seed).status, 'seeded');
  assert.deepEqual(seed.seqs, []);
  const changed = [{ path: 'src/shared.ts', new_hash: SHA('c') }, { path: 'src/same.ts', new_hash: SHA('b') }];
  const stale = await run('base.observe', { old_sha: SHA('9'), new_sha: SHA('3'), changed }, device);
  assert.deepEqual(res(stale), { status: 'stale', tip: SHA('1') });
  const applied = await run('base.observe', { old_sha: SHA('1'), new_sha: SHA('3'), changed }, other);
  assert.equal(res(applied).status, 'applied');
  const events = await kinds(applied.seqs);
  assert.deepEqual(events.map((e) => e.kind), ['base.advanced', 'message.sent']);
  assert.match(events[1].data.text, /src\/shared\.ts has changed since you read it/);
  assert.match(events[1].data.text, /a merge outside the harness \(commit 3333333\)/);
  assert.equal(events[1].data.new_base_sha, SHA('3'));
  assert.deepEqual(events[1].data.paths, ['src/shared.ts'], 'the unchanged file is not news');
  // Another daemon reporting the same move: known, nothing new.
  const again = await run('base.observe', { old_sha: SHA('1'), new_sha: SHA('3'), changed }, device);
  assert.deepEqual([res(again).status, again.seqs], ['known', []]);
  assert.equal((await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha, SHA('3'));
  await rejects(run('base.observe', { old_sha: SHA('3'), new_sha: SHA('3'), changed: [] }, device), 'bad_request');
  await rejects(run('base.observe', { old_sha: SHA('3'), new_sha: SHA('4'), changed: [] }), 'forbidden', /only harnessd/);
  // A reader whose base predates an outside move hears of it when it reads one of its files (trigger 2b).
  const late = await finished('agent/r2');
  await db.pool.query("UPDATE tasks SET base_set_at = now() - interval '1 hour' WHERE id = $1", [late.task]);
  const r = await late.read('src/shared.ts', SHA('a'));
  const notices = (await kinds(r.seqs)).filter((e) => e.kind === 'message.sent');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].data.land_id, `base:${SHA('3')}`);
});

test('a move seen while a merge is armed is parked: no notice, no tip move, until the merge\'s outcome is known', async () => {
  const w = await finished('agent/a1');
  await w.complete();
  const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha;
  await db.pool.query(
    `INSERT INTO lands (id, project_id, task_id, device_id, requested_by, status, mode, pr_number, approved_head_sha, approved_base_sha, step, merge_requested_at)
     VALUES ('land_armed00000000', $1, $2, 'dev_1', 'human_test', 'accepted', 'github', 9, $3, $4, 'merge_requested', now())`, [project, w.task, SHA('2'), tip]);
  try {
    const r = await run('base.observe', { old_sha: tip, new_sha: SHA('6'), changed: [{ path: 'x.ts', new_hash: SHA('d') }] }, other);
    assert.deepEqual(res(r), { status: 'parked', land_id: 'land_armed00000000' });
    assert.deepEqual(r.seqs, []);
    assert.equal((await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha, tip);
    assert.equal((await db.pool.query('SELECT status FROM base_advances WHERE new_sha = $1', [SHA('6')])).rows[0].status, 'parked');
  } finally {
    await db.pool.query("UPDATE lands SET status = 'failed', reason = 'error' WHERE id = 'land_armed00000000'");
    await db.pool.query('DELETE FROM base_advances WHERE new_sha = $1', [SHA('6')]);
  }
});

test('a PR merged outside the harness lands once: task landed, leases released, readers told, the chain moved', async () => {
  const w = await finished('agent/x1');
  const reader = await finished('agent/x2');
  await reader.read('src/api.ts', SHA('a'));
  await w.complete();
  await publish(w.task, 11);
  const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha;
  const token = Number((await db.pool.query('UPDATE projects SET next_fencing_token = next_fencing_token + 1 WHERE id = $1 RETURNING next_fencing_token', [project])).rows[0].next_fencing_token);
  await db.pool.query("INSERT INTO leases (id, project_id, task_id, path, token, expires_at) VALUES ('ls_x1', $1, $2, 'src/api.ts', $3, now() + interval '10 minutes')", [project, w.task, token]);
  const args = { task_id: w.task, pr_number: 11, merge_sha: SHA('7'), old_base_sha: tip, changed: [{ path: 'src/api.ts', new_hash: SHA('e') }] };
  await rejects(run('land.external', { ...args, pr_number: 12 }, device), 'conflict', /#12/);
  const stale = await run('land.external', { ...args, old_base_sha: SHA('8') }, device);
  assert.equal(res(stale).status, 'stale');
  const r = await run('land.external', args, device);
  assert.equal(res(r).status, 'landed');
  const events = await kinds(r.seqs);
  assert.deepEqual(events.map((e) => e.kind), ['land.completed', 'lease.released', 'message.sent']);
  assert.equal(events[0].data.external, true);
  assert.equal(events[0].data.new_base_sha, SHA('7'));
  assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [w.task])).rows[0].status, 'landed');
  assert.deepEqual((await db.pool.query('SELECT merged, merge_sha FROM task_prs WHERE task_id = $1', [w.task])).rows[0], { merged: true, merge_sha: SHA('7') });
  assert.equal((await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha, SHA('7'));
  // Once: a repeat, and an observation of the same commit by another daemon, are both known.
  assert.equal(res(await run('land.external', args, device)).status, 'known');
  assert.equal(res(await run('base.observe', { old_sha: tip, new_sha: SHA('7'), changed: [] }, other)).status, 'known');
});

test('a land in flight for the task is the harness\'s own merge: land.external leaves it to its device', async () => {
  const w = await finished('agent/y1');
  await w.complete();
  await publish(w.task, 13);
  await db.pool.query(
    `INSERT INTO lands (id, project_id, task_id, device_id, requested_by, status, mode, pr_number) VALUES ('land_inflight00000', $1, $2, 'dev_2', 'human_test', 'accepted', 'github', 13)`, [project, w.task]);
  try {
    const r = await run('land.external', { task_id: w.task, pr_number: 13, merge_sha: SHA('9'), old_base_sha: SHA('7'), changed: [] }, device);
    assert.deepEqual(res(r), { status: 'reservation_active', land_id: 'land_inflight00000' });
  } finally {
    await db.pool.query("UPDATE lands SET status = 'failed', reason = 'error' WHERE id = 'land_inflight00000'");
  }
});

test('the project\'s mode decides: no local land in a GitHub project, no GitHub records in a local one', async () => {
  const w = await finished('agent/m1');
  await w.complete();
  await rejects(run('land.request', { task_id: w.task }), 'conflict', /integrates through GitHub/);
  await rejects(run('land.request', { task_id: w.task, run_tests: false }), 'conflict', /integrates through GitHub/);
  const l = await finished('agent/m2', local);
  await l.complete();
  await rejects(run('pr.publish', { task_id: l.task, pr_number: 1, url: 'https://x', head_sha: SHA('2'), base_sha: SHA('1'), remote_ref: 'refs/heads/b' }, device, local), 'conflict', /lands locally/);
  await rejects(run('base.observe', { old_sha: SHA('1'), new_sha: SHA('2'), changed: [] }, device, local), 'conflict', /lands locally/);
  const landId = res(await run('land.request', { task_id: l.task }, human, local)).land_id;
  assert.match(landId, /^land_/);
  await run('land.cancel', { task_id: l.task }, human, local);
});

test('a PR merge another daemon saw first as an outside move of the base still lands its task, once, with no second notice', async () => {
  const w = await finished('agent/z1');
  await w.complete();
  await publish(w.task, 21);
  const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha;
  const changed = [{ path: 'src/z.ts', new_hash: SHA('f') }];
  const seen = await run('base.observe', { old_sha: tip, new_sha: SHA('a'), changed }, other);
  assert.equal(res(seen).status, 'applied');
  const r = await run('land.external', { task_id: w.task, pr_number: 21, merge_sha: SHA('a'), old_base_sha: tip, changed }, device);
  assert.equal(res(r).status, 'landed');
  assert.deepEqual((await kinds(r.seqs)).map((e) => e.kind), ['land.completed'], 'no second notice, no tip move');
  assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [w.task])).rows[0].status, 'landed');
  assert.match((await db.pool.query('SELECT source FROM base_advances WHERE new_sha = $1', [SHA('a')])).rows[0].source, /^land:/);
  assert.equal(res(await run('land.external', { task_id: w.task, pr_number: 21, merge_sha: SHA('a'), old_base_sha: tip, changed }, device)).status, 'known');
});

test('an armed GitHub land fails only on GitHub\'s evidence, can\'t be cancelled, and can\'t complete unless armed', async () => {
  const w = await finished('agent/g1');
  await w.complete();
  await publish(w.task, 31);
  const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha;
  const approver = { principal: 'human_test', deviceId: null, authDeviceId: 'dev_1' };
  // The approver's integrate dispatch (D-112): exactly this PR, head and base.
  const integrate = (x: { pr_number: number; head_sha: string; base_sha: string }) => dispatchFor(db.pool, parsePrivateKey(key1.privateKeyPem), {
    kind: 'integrate', projectId: project, taskId: w.task, agentId: w.agent, targetDevice: 'dev_1', issuerHuman: 'human_test', issuerDevice: 'dev_1',
    integrate: { ...x, paths_sha256: '0'.repeat(64) },
  });
  const request = { task_id: w.task, mode: 'github', pr_number: 31, head_sha: SHA('2'), base_sha: tip };
  await rejects(run('land.request', request, approver), 'forbidden', /dispatch refused \(missing\)/);
  await rejects(run('land.request', { ...request, dispatch: await integrate({ pr_number: 31, head_sha: SHA('2'), base_sha: SHA('9') }) }, approver), 'forbidden', /content_mismatch/);
  const signed = await integrate({ pr_number: 31, head_sha: SHA('2'), base_sha: tip });
  const requested = await run('land.request', { ...request, dispatch: signed }, approver);
  const land = res(requested).land_id;
  assert.deepEqual((await kinds(requested.seqs))[0].data.dispatch, signed, 'echoed for the device that merges, which checks it again');
  assert.equal((await db.pool.query('SELECT dispatch_nonce FROM lands WHERE id = $1', [land])).rows[0].dispatch_nonce, signed.envelope.nonce);
  const accepted = await run('land', { land_id: land, base_branch: 'main', base_sha: tip, merge_base_sha: tip, head_sha: SHA('2'), changed_paths: ['src/g.ts'], lease_tokens: [] }, device);
  assert.equal(res(accepted).accepted, true);
  await rejects(run('land.complete', { land_id: land, old_base_sha: tip, new_base_sha: SHA('b'), changed: [] }, device), 'conflict', /never armed/);
  await rejects(run('land.arm', { land_id: land, head_sha: SHA('3'), base_sha: tip }, device), 'conflict', /approved/);
  await run('land.arm', { land_id: land, head_sha: SHA('2'), base_sha: tip }, device);
  await rejects(run('land.cancel', { task_id: w.task }), 'conflict', /can't be cancelled/);
  await rejects(run('land.fail', { land_id: land, reason: 'error', detail: 'timeout' }, device), 'conflict', /armed/);
  await rejects(run('land.fail', { land_id: land, reason: 'pr_closed' }, device), 'conflict', /evidence/);
  const failed = await run('land.fail', { land_id: land, reason: 'pr_closed', evidence: { state: 'closed', merged: false, head_sha: SHA('2') } }, device);
  assert.deepEqual((await kinds(failed.seqs)).map((e) => e.kind), ['land.failed']);
});

test('land.reconcile: another member device settles a silent device\'s GitHub land from GitHub\'s evidence, once (D-115)', async () => {
  // A finished task, published, its integration accepted and armed on dev_1, which then goes silent.
  const armed = async (name: string, pr: number) => {
    const w = await finished(name);
    await w.complete();
    await publish(w.task, pr);
    const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0]?.tip_sha ?? SHA('1');
    const x = { pr_number: pr, head_sha: SHA('2'), base_sha: tip };
    const dispatch = await dispatchFor(db.pool, parsePrivateKey(key1.privateKeyPem), {
      kind: 'integrate', projectId: project, taskId: w.task, agentId: w.agent, targetDevice: 'dev_1', issuerHuman: 'human_test', issuerDevice: 'dev_1',
      integrate: { ...x, paths_sha256: '0'.repeat(64) },
    });
    const land = res(await run('land.request', { task_id: w.task, mode: 'github', ...x, dispatch }, owner)).land_id as string;
    assert.equal(res(await run('land', { land_id: land, base_branch: 'main', base_sha: tip, merge_base_sha: tip, head_sha: SHA('2'), changed_paths: ['src/r.ts'], lease_tokens: [] }, device)).accepted, true);
    await run('land.arm', { land_id: land, head_sha: SHA('2'), base_sha: tip }, device);
    return { ...w, land, tip };
  };
  const silent = (minutes: number) => db.pool.query(`UPDATE devices SET last_heartbeat_at = now() - make_interval(mins => $1) WHERE id = 'dev_1'`, [minutes]);
  const reconcile = (land: string, pr: number, over: Record<string, unknown>, caller = other) =>
    run('land.reconcile', { land_id: land, pr_number: pr, observed_head_sha: SHA('2'), observed_base_sha: SHA('1'), merged: false, state: 'open', ...over }, caller);

  // Nothing merged: released, as interrupted.
  const a = await armed('agent/rc1', 41);
  await silent(1);
  await rejects(reconcile(a.land, 41, {}), 'conflict', /heard from in the last 10 minutes/);
  await silent(11);
  await rejects(reconcile(a.land, 41, {}, device), 'forbidden', /its own device settles it/);
  await rejects(reconcile(a.land, 42, {}), 'bad_request', /PR #41/);
  const released = await reconcile(a.land, 41, {});
  assert.deepEqual(res(released), { status: 'failed', reason: 'interrupted' });
  const [failed] = await kinds(released.seqs);
  assert.deepEqual([failed.kind, failed.data.reason, failed.data.reconciled_by], ['land.failed', 'interrupted', 'dev_2']);
  assert.deepEqual(res(await reconcile(a.land, 41, {})), { status: 'failed', settled: true }, 'once');
  await rejects(run('land.arm', { land_id: a.land, head_sha: SHA('2'), base_sha: a.tip }, device), 'conflict');

  // Merged, but not what was approved: never landed, with an alert.
  const b = await armed('agent/rc2', 43);
  await silent(11);
  const unverified = await reconcile(b.land, 43, { merged: true, merge_sha: SHA('c'), verified: false, changed: [] });
  assert.deepEqual((await kinds(unverified.seqs)).map((e) => [e.kind, e.data.reason ?? e.data.what]), [['land.failed', 'verification_failed'], ['security.alert', 'merge_not_approved']]);
  assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [b.task])).rows[0].status, 'done');

  // Merged as approved: completed, as its own device would have, and the task landed.
  const c = await armed('agent/rc3', 44);
  await silent(11);
  const merged = await reconcile(c.land, 44, { merged: true, merge_sha: SHA('d'), verified: true, changed: [{ path: 'src/r.ts', new_hash: SHA('e') }] });
  const done = (await kinds(merged.seqs)).find((e) => e.kind === 'land.completed')!;
  assert.deepEqual([done.data.new_base_sha, done.data.reconciled_by, done.data.changed_paths], [SHA('d'), 'dev_2', ['src/r.ts']]);
  assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [c.task])).rows[0].status, 'landed');
  assert.equal((await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha, SHA('d'), 'the chain moved');
});
