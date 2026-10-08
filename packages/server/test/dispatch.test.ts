// Signed dispatch and device routing, the server's half (D-112, D-113; protocol.md §11). A lifecycle command from a
// device-key connection carries a dispatch its own device signed, for the task and agent as stored, aimed at the
// agent's device; the server keeps its nonce once. Only the task's owner or the agent's human acts on a task. A
// task has at most one live session, and the target device can refuse a dispatch, which frees the agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, type KeyObject } from 'node:crypto';
import type { DispatchKind } from '@harness/protocol';
import {
  DISPATCH_CONTEXT, generateKeyPair, messageSha256, newNonce, parsePrivateKey, signDispatch, signPayload, taskSha256,
} from '@harness/protocol/signing';
import { executeCommand, CommandError, type Caller } from '../src/commands.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
let epoch: string;
let agentA: string; // human_test's, on dev_a
let agentB: string; // human_b's, on dev_b
const keys: Record<string, { priv: KeyObject; pub: string }> = {};
const key = () => { const k = generateKeyPair(); return { priv: parsePrivateKey(k.privateKeyPem), pub: k.publicKey }; };

// The CLI or UI of each human, on their own device; and each device's harnessd.
const cliA: Caller = { principal: 'human_test', deviceId: null, authDeviceId: 'dev_a' };
const cliA2: Caller = { principal: 'human_test', deviceId: null, authDeviceId: 'dev_a2' };
const cliB: Caller = { principal: 'human_b', deviceId: null, authDeviceId: 'dev_b' };
const daemonA: Caller = { principal: 'human_test', deviceId: 'dev_a', authDeviceId: 'dev_a' };
const daemonA2: Caller = { principal: 'human_test', deviceId: 'dev_a2', authDeviceId: 'dev_a2' };
const daemonB: Caller = { principal: 'human_b', deviceId: 'dev_b', authDeviceId: 'dev_b' };
const tokenA: Caller = { principal: 'human_test', deviceId: null }; // a local-token stack (0B)

const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (caller: Caller, name: string, args: Record<string, unknown>, asAgent?: string) => executeCommand(db.pool, caller, cmd(name, args, asAgent));
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) =>
  assert.rejects(p, (e) => e instanceof CommandError && e.code === code && (!re || re.test(e.message)) || assert.fail(`got ${String(e)}`));
const events = async (seqs: number[]) =>
  (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, seqs])).rows;
const taskRow = async (id: string) =>
  (await db.pool.query('SELECT status, assignee_agent_id FROM tasks WHERE id = $1', [id])).rows[0];

async function newTask(caller: Caller = cliA, title = 'Login API'): Promise<string> {
  return ((await run(caller, 'task.create', { title, text: 'Build POST /login.', scope: ['src/api/'] })).result as { task_id: string }).task_id;
}

/** A dispatch for the task and agent as stored, signed by `issuer` (a device id), with any field overridden. */
async function dispatch(kind: DispatchKind, taskId: string, agentId: string, o: {
  issuer?: string; human?: string; signer?: string; message?: string; fields?: Record<string, unknown>;
} = {}) {
  const t = (await db.pool.query('SELECT title, text, scope, owner_human_id FROM tasks WHERE id = $1', [taskId])).rows[0];
  const target = (await db.pool.query('SELECT device_id FROM agent_principals WHERE id = $1', [agentId])).rows[0].device_id;
  const issuer = o.issuer ?? 'dev_a';
  const now = Date.now();
  const envelope = {
    v: 1 as const, kind, project_id: project, task_id: taskId, agent_id: agentId, target_device_id: target,
    issuer_human_id: o.human ?? (issuer.startsWith('dev_b') ? 'human_b' : 'human_test'), issuer_device_id: issuer, epoch, nonce: newNonce(),
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), task_sha256: taskSha256(t),
    ...(o.message === undefined ? {} : { message_sha256: messageSha256(o.message) }), ...o.fields,
  };
  return signDispatch(keys[o.signer ?? issuer]!.priv, envelope);
}

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool); // human_test owns it
  epoch = (await db.pool.query('SELECT epoch FROM coordinator_epoch')).rows[0].epoch;
  await db.pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_b', 'B')");
  await db.pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ($1, 'human_b', 'member')", [project]);
  for (const [id, human] of [['dev_a', 'human_test'], ['dev_a2', 'human_test'], ['dev_a3', 'human_test'], ['dev_b', 'human_b']]) {
    keys[id!] = key();
    await db.pool.query('INSERT INTO devices (id, human_id, name, public_key) VALUES ($1, $2, $1, $3)', [id, human, keys[id!]!.pub]);
  }
  await db.pool.query("UPDATE devices SET revoked_at = now() WHERE id = 'dev_a3'");
  agentA = ((await run(cliA, 'agent.create', { name: 'agent/a', vendor: 'claude' })).result as { agent_id: string }).agent_id;
  agentB = ((await run(cliB, 'agent.create', { name: 'agent/b', vendor: 'claude' })).result as { agent_id: string }).agent_id;
});
after(async () => { await db?.drop(); });

test('agent.create binds the agent to the caller\'s device, or another of its human\'s; never someone else\'s', async () => {
  const created = (await events((await run(cliA, 'agent.create', { name: 'agent/a-other', vendor: 'claude', device_id: 'dev_a2' })).seqs))[0];
  assert.equal(created.data.device_id, 'dev_a2');
  assert.equal((await db.pool.query('SELECT device_id FROM agent_principals WHERE id = $1', [agentA])).rows[0].device_id, 'dev_a');
  await rejects(run(cliA, 'agent.create', { name: 'agent/x', vendor: 'claude', device_id: 'dev_b' }), 'forbidden', /isn't one of/);
  await rejects(run(cliA, 'agent.create', { name: 'agent/x', vendor: 'claude', device_id: 'dev_a3' }), 'forbidden', /isn't one of/); // revoked
  const local = (await events((await run(tokenA, 'agent.create', { name: 'agent/local', vendor: 'claude' })).seqs))[0];
  assert.equal(local.data.device_id, undefined); // a local-token stack leaves it unbound
});

test('a signed start is accepted and echoed with its target device; every forged or stale one is refused with its reason', async () => {
  const id = await newTask();
  const refused = async (d: unknown, reason: string, caller: Caller = cliA) => {
    await rejects(run(caller, 'task.assign', { task_id: id, assignee_agent_id: agentA, ...(d === undefined ? {} : { dispatch: d }) }), reason === 'replayed' ? 'conflict' : 'forbidden', new RegExp(`\\(${reason}\\)`));
    assert.deepEqual(await taskRow(id), { status: 'open', assignee_agent_id: null }, `still open after ${reason}`);
  };
  await refused(undefined, 'missing');
  await refused(await dispatch('start', id, agentA, { signer: 'dev_b' }), 'bad_signature');
  await refused(await dispatch('start', id, agentA), 'issuer_mismatch', cliA2); // signed by dev_a, sent from dev_a2
  await refused(await dispatch('start', id, agentA, { issuer: 'dev_a3' }), 'unknown_issuer', { ...cliA, authDeviceId: 'dev_a3' }); // revoked
  await refused(await dispatch('start', id, agentA, { fields: { target_device_id: 'dev_a2' } }), 'wrong_target');
  await refused(await dispatch('start', id, agentA, { fields: { epoch: '0123456789abcdef' } }), 'wrong_epoch');
  await refused(await dispatch('reopen', id, agentA, { message: 'x' }), 'wrong_kind');
  await refused(await dispatch('start', id, agentA, { fields: { task_sha256: taskSha256({ title: 'Login API', text: 'Delete everything.', scope: ['src/api/'], owner_human_id: 'human_test' }) } }), 'content_mismatch');
  const past = Date.now() - 2 * 3_600_000;
  await refused(await dispatch('start', id, agentA, { fields: { issued_at: new Date(past).toISOString(), expires_at: new Date(past + 3_600_000).toISOString() } }), 'expired');
  // A dispatch can't carry local policy at all (T-5b): refused before its signature is even read.
  const ok = await dispatch('start', id, agentA);
  const widened = { ...ok.envelope, budget: 100 };
  await refused({ envelope: widened, sig: signPayload(keys.dev_a!.priv, DISPATCH_CONTEXT, widened) }, 'policy_widening');
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM dispatches WHERE task_id = $1', [id])).rows[0].n, 0);

  const out = await run(cliA, 'task.assign', { task_id: id, assignee_agent_id: agentA, dispatch: ok });
  const [assigned] = await events(out.seqs);
  assert.equal(assigned.kind, 'task.assigned');
  assert.deepEqual(assigned.data, { task_id: id, assignee_agent_id: agentA, dispatch: ok, target_device_id: 'dev_a' });
  // The same command again (a retry) gets the stored outcome; the same dispatch in a new command is a replay.
  await run(daemonA, 'dispatch.rejected', { task_id: id, nonce: ok.envelope.nonce, reason: 'approval_denied' }); // frees it
  assert.deepEqual(await taskRow(id), { status: 'open', assignee_agent_id: null });
  await refused(ok, 'replayed');
});

test('with signed dispatch, a task is created first and then assigned: its id is the server\'s', async () => {
  await rejects(run(cliA, 'task.create', { title: 't', text: 't', scope: [], assignee_agent_id: agentA }), 'bad_request', /then assign/);
});

test('only the task\'s owner or its agent\'s human acts on it (D-112)', async () => {
  const mine = await newTask(cliA, 'A\'s task');
  await rejects(run(cliB, 'task.assign', { task_id: mine, assignee_agent_id: agentA, dispatch: await dispatch('start', mine, agentA, { issuer: 'dev_b' }) }), 'forbidden', /owner or its agent's human/);
  await rejects(run(cliB, 'task.abandon', { task_id: mine, reason: 'no' }), 'forbidden', /owner or its agent's human/);
  await rejects(run(cliB, 'task.complete', { task_id: mine }), 'forbidden', /owner or its agent's human/);
  // B owns this one, so B may give it to A's agent; A's harnessd then asks A to approve it locally (D-34, PA3).
  const theirs = await newTask(cliB, 'B\'s task for A\'s agent');
  const d = await dispatch('start', theirs, agentA, { issuer: 'dev_b' });
  const [ev] = await events((await run(cliB, 'task.assign', { task_id: theirs, assignee_agent_id: agentA, dispatch: d })).seqs);
  assert.equal(ev.data.target_device_id, 'dev_a');
  // A, as the agent's human, may act on it too: here, abandon it with a signed abandon.
  await run(cliA, 'task.abandon', { task_id: theirs, reason: 'not now', dispatch: await dispatch('abandon', theirs, agentA) });
  // The rule holds on a local-token stack too.
  const other = await newTask(tokenA, 'local');
  await rejects(run({ principal: 'human_b', deviceId: null }, 'task.abandon', { task_id: other, reason: 'no' }), 'forbidden', /owner or its agent's human/);
});

test('one live session per task, only on the agent\'s device; a stopped task resumes there with a signed resume', async () => {
  const id = await newTask();
  await run(cliA, 'task.assign', { task_id: id, assignee_agent_id: agentA, dispatch: await dispatch('start', id, agentA) });
  const start = (sid: string, caller: Caller) => run(caller, 'session.report', { session_id: sid, status: 'starting', task_id: id, worktree: '/w/x', branch: 'harness/x' }, agentA);
  await rejects(start(randomUUID(), daemonA2), 'forbidden', /wrong_device/); // A's other Mac can't run an agent bound to dev_a
  const first = randomUUID();
  await start(first, daemonA);
  await rejects(start(randomUUID(), daemonA), 'conflict', new RegExp(`live_session_exists: ${first} on dev_a`)); // a replayed event, say
  const resume = await dispatch('resume', id, agentA, { message: 'Carry on from the failing test.' });
  await rejects(run(cliA, 'task.resume', { task_id: id, text: 'Carry on from the failing test.', dispatch: resume }), 'conflict', /live_session_exists/);
  await run(daemonA, 'session.report', { session_id: first, status: 'ended', reason: 'harnessd_restarted' }, agentA); // now it's stopped
  await rejects(run(cliA, 'task.resume', { task_id: id, text: 'Something else.', dispatch: resume }), 'forbidden', /content_mismatch/);
  await rejects(run(cliA, 'task.resume', { task_id: id, dispatch: resume }), 'forbidden', /content_mismatch/); // the message is covered
  const [ev] = await events((await run(cliA, 'task.resume', { task_id: id, text: 'Carry on from the failing test.', dispatch: resume })).seqs);
  assert.equal(ev.kind, 'task.resumed');
  assert.deepEqual(ev.data, { task_id: id, assignee_agent_id: agentA, text: 'Carry on from the failing test.', by: 'human_test', dispatch: resume, target_device_id: 'dev_a' });
  await rejects(run(cliA, 'task.resume', { task_id: id, text: 'Carry on from the failing test.', dispatch: resume }), 'conflict', /replayed/);
  await start(randomUUID(), daemonA); // the resumed session
  await rejects(run(cliA, 'task.resume', { task_id: id, dispatch: await dispatch('resume', id, agentA) }), 'conflict', /live_session_exists/);
  await run(cliA, 'task.abandon', { task_id: id, reason: 'free agent A', dispatch: await dispatch('abandon', id, agentA) });
});

test('the target device refuses a dispatch or fails a start: the agent is freed, once per nonce; a forged event is only logged', async () => {
  const id = await newTask();
  const d = await dispatch('start', id, agentA);
  await run(cliA, 'task.assign', { task_id: id, assignee_agent_id: agentA, dispatch: d });
  await rejects(run(cliA, 'dispatch.rejected', { task_id: id, nonce: d.envelope.nonce, reason: 'approval_denied' }), 'forbidden', /only harnessd/);
  await rejects(run(daemonB, 'dispatch.rejected', { task_id: id, nonce: d.envelope.nonce, reason: 'approval_denied' }), 'forbidden', /targets dev_a/);
  const out = await run(daemonA, 'task.start_failed', { task_id: id, nonce: d.envelope.nonce, reason: 'setup_failed', detail: 'npm ci failed' });
  const [ev] = await events(out.seqs);
  assert.deepEqual(ev, { kind: 'task.start_failed', data: { task_id: id, nonce: d.envelope.nonce, reason: 'setup_failed', detail: 'npm ci failed', device_id: 'dev_a', kind: 'start', status: 'open' } });
  assert.deepEqual(await taskRow(id), { status: 'open', assignee_agent_id: null });
  const again = await run(daemonA, 'dispatch.rejected', { task_id: id, nonce: d.envelope.nonce, reason: 'expired' });
  assert.deepEqual([again.seqs, again.result], [[], { status: 'open', duplicate: true }]);
  // The agent is free for other work.
  const next = await newTask();
  await run(cliA, 'task.assign', { task_id: next, assignee_agent_id: agentA, dispatch: await dispatch('start', next, agentA) });
  await run(daemonA, 'session.report', { session_id: randomUUID(), status: 'starting', task_id: next, worktree: '/w/n', branch: 'harness/n' }, agentA);

  // A reopen the device refuses leaves the task done, as it was.
  const done = await newTask();
  await run(cliB, 'task.assign', { task_id: done, assignee_agent_id: agentB, dispatch: await dispatch('start', done, agentB, { issuer: 'dev_b' }) });
  await run(daemonB, 'task.complete', { task_id: done, summary: 'built' }, agentB); // the agent's own report_done needs no dispatch
  const reopen = await dispatch('reopen', done, agentB, { issuer: 'dev_b', message: 'Fix the test.' });
  await run(cliB, 'task.reopen', { task_id: done, text: 'Fix the test.', dispatch: reopen });
  const refused = await run(daemonB, 'dispatch.rejected', { task_id: done, nonce: reopen.envelope.nonce, reason: 'bad_signature' });
  assert.deepEqual((await events(refused.seqs)).map((e) => e.kind), ['task.dispatch_rejected', 'security.alert', 'claim.cleared']);
  assert.equal((await taskRow(done)).status, 'done');

  // An event the server never accepted (forged straight into the log, T-3): logged with an alert, nothing changes.
  const forged = await run(daemonA, 'dispatch.rejected', { task_id: next, reason: 'missing', kind: 'start' });
  assert.deepEqual((await events(forged.seqs)).map((e) => e.kind), ['task.dispatch_rejected']);
  const bad = await run(daemonA, 'dispatch.rejected', { task_id: next, nonce: newNonce(), reason: 'bad_signature' });
  assert.deepEqual((await events(bad.seqs)).map((e) => e.kind), ['task.dispatch_rejected', 'security.alert']);
  assert.deepEqual(await taskRow(next), { status: 'in_progress', assignee_agent_id: agentA });
  await rejects(run(daemonB, 'dispatch.rejected', { task_id: next, reason: 'missing' }), 'forbidden', /agent's device/);
});

test('a local-token stack keeps 0B\'s behaviour: no dispatch needed, none echoed', async () => {
  const local = ((await run(tokenA, 'agent.create', { name: 'agent/local-2', vendor: 'claude' })).result as { agent_id: string }).agent_id;
  const created = await run(tokenA, 'task.create', { title: 't', text: 't', scope: [], assignee_agent_id: local });
  const assigned = (await events(created.seqs)).find((e) => e.kind === 'task.assigned');
  assert.deepEqual(assigned.data, { task_id: (created.result as { task_id: string }).task_id, assignee_agent_id: local });
});

test('migration 0015 ends duplicate live sessions, keeping each task\'s newest, and logs each ending', async () => {
  const id = await newTask();
  await db.pool.query('DROP INDEX agent_sessions_one_live_per_task');
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const [i, sid] of ids.entries()) {
    await db.pool.query(
      `INSERT INTO agent_sessions (id, agent_id, device_id, task_id, worktree_path, branch, status, started_at)
       VALUES ($1, $2, 'dev_a', $3, '/w', 'b', 'working', now() - make_interval(mins => $4))`, [sid, agentA, id, 10 - i]);
  }
  const sql = fs.readFileSync(new URL('../migrations/0015_dispatch.sql', import.meta.url), 'utf8');
  await db.pool.query(sql.slice(sql.indexOf('DO $$')));
  const live = (await db.pool.query("SELECT id FROM agent_sessions WHERE task_id = $1 AND status <> 'ended'", [id])).rows.map((r) => r.id);
  assert.deepEqual(live, [ids[2]]);
  const logged = (await db.pool.query("SELECT data FROM events WHERE project_id = $1 AND kind = 'session.ended' AND data ->> 'task_id' = $2 ORDER BY seq", [project, id])).rows;
  assert.deepEqual(logged.map((r) => [r.data.session_id, r.data.reason]), [[ids[0], 'superseded_by_0015'], [ids[1], 'superseded_by_0015']]);
});
