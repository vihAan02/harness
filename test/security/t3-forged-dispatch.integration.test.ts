// T-3, a forged command (security.md §8; D-112; validation.md §7): the coordinator is not this Mac's root of trust.
// A device the server registered for a human, but that this Mac never pinned (a tampered coordinator database, say),
// starts this human's agent. The server accepts the dispatch, since its registry says the key is fine; harnessd
// refuses it against its own pins, reports it, and the server frees the agent. Nothing ran.
// The server, both harnessds, Git and the fake GitHub are real; the agents are stand-ins (test/fake-adapter.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { SignedDispatch } from '../../packages/protocol/src/index.ts';
import { generateKeyPair, parsePrivateKey } from '../../packages/protocol/src/signing.ts';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import type { LocalConfig } from '../../packages/daemon/src/config.ts';
import { makeDispatch, type DispatchTask } from '../../packages/daemon/src/dispatch.ts';
import { dispatchFor } from '../../packages/server/test/helpers.ts';
import { forgeEvents, openDeviceClient, startPilotStack, type PilotStack } from '../support.ts';

const dataOf = (e: { data: unknown }) => e.data as Record<string, any>;

test('T-3: a start dispatched from a device this Mac never pinned is refused here, though the server took it; the agent is freed', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, portRanges: { a: [32100, 32199], b: [32200, 32299] } });
  try {
    const agent = (await s.a.command('agent.create', { name: 'agent/target', vendor: 'claude' })).agent_id!;
    // A second device for human_b, in the coordinator's registry only: neither Mac's config pins it.
    const x = generateKeyPair();
    await s.db.pool.query("INSERT INTO devices (id, human_id, name, public_key) VALUES ('dev_x', 'human_b', 'not-a-mac', $1)", [x.publicKey]);
    const config = { auth: 'device-key', deviceId: 'dev_x', principal: 'human_b', serverKey: s.serverKey, serverUrl: s.server.url } as LocalConfig;
    const client = await openDeviceClient(s.server.url, config, parsePrivateKey(x.privateKeyPem), [{ project_id: s.project, after_seq: 0 }]);
    try {
      const command = async (name: string, args: Record<string, unknown>) => {
        const command_id = randomUUID();
        client.send({ v: 1, type: 'command', command_id, project_id: s.project, name, args });
        const r = await client.next('command_result', (m) => m.command_id === command_id, 10_000);
        if (!r.ok) throw new Error(`${name}: ${r.error.code}: ${r.error.message}`);
        return (r.result ?? {}) as Record<string, string>;
      };
      const task = (await command('task.create', { title: 'cleanup', text: 'Tidy up src/.', scope: [] })).task_id!;
      const dispatch = await dispatchFor(s.db.pool, parsePrivateKey(x.privateKeyPem), {
        kind: 'start', projectId: s.project, taskId: task, agentId: agent, targetDevice: 'dev_a', issuerHuman: 'human_b', issuerDevice: 'dev_x',
      });
      await command('task.assign', { task_id: task, assignee_agent_id: agent, dispatch }); // the server accepts it

      const rejected = () => s.a.acted.find((e) => e.kind === 'task.dispatch_rejected' && dataOf(e).task_id === task);
      await s.until(() => !!rejected(), 20_000, 'the refusal to reach the server');
      assert.deepEqual([dataOf(rejected()!).reason, dataOf(rejected()!).nonce, dataOf(rejected()!).status], ['unknown_issuer', dispatch.envelope.nonce, 'open']);
      assert.ok(!s.a.daemon.running.has(task) && s.a.adapter.sessions.length === 0, 'nothing ran');
      assert.deepEqual((await s.db.pool.query('SELECT status, assignee_agent_id FROM tasks WHERE id = $1', [task])).rows[0], { status: 'open', assignee_agent_id: null });
      assert.ok(s.a.logs.some((l) => l.includes(`${task}: refused a start dispatch (unknown_issuer)`)));
      // The agent is free again: its own human can give it work.
      const mine = await s.a.assign(agent, { title: 'real work', text: 'Do the real work.' });
      await s.until(() => s.a.daemon.running.has(mine), 20_000, 'the agent to start on its human\'s task');
    } finally {
      client.close();
    }
  } finally { await s.stop(); }
});

/** A start written straight into the coordinator's log (support.ts forgeEvents), its tables kept in step, so harnessd's refusal is heard. */
const forge = async (s: PilotStack, kind: 'task.assigned', task: string, agent: string, dispatch: unknown): Promise<number> => (await forgeEvents(s, [{
  kind, actor: 'human_b', deviceId: 'dev_b', data: { task_id: task, assignee_agent_id: agent, target_device_id: 'dev_a', ...(dispatch === undefined ? {} : { dispatch }) },
}], [["UPDATE tasks SET assignee_agent_id = $2, status = 'in_progress' WHERE id = $1", [task, agent]]]))[0]!;

test('T-3, every case of validation.md §7, written straight into the coordinator\'s log: refused here, reported, nothing runs; a valid one starts once', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, portRanges: { a: [32100, 32199], b: [32200, 32299] }, daemonOptions: { approvalPollMs: 50 } });
  try {
    const agent = (await s.a.command('agent.create', { name: 'agent/target', vendor: 'claude' })).agent_id!;
    const epoch = s.a.daemon.link!.epoch!;
    const stranger = parsePrivateKey(generateKeyPair().privateKeyPem);
    const task = async (title: string) => {
      const id = (await s.b.command('task.create', { title, text: 'Tidy up src/.', scope: ['src/'] })).task_id!;
      await s.until(() => s.a.daemon.view(s.project).tasks.has(id), 10_000, `${id} in A's view`);
      const t = s.a.daemon.view(s.project).tasks.get(id)!;
      return { id: t.id, title: t.title, text: t.text, scope: t.scope, ownerHumanId: t.ownerHumanId };
    };
    type Over = Partial<Parameters<typeof makeDispatch>[1]>;
    const sign = (t: DispatchTask, over: Over = {}, key = s.b.deviceKey) => makeDispatch(key, {
      kind: 'start', projectId: s.project, taskId: t.id, agentId: agent, targetDeviceId: 'dev_a', issuerHumanId: 'human_b', issuerDeviceId: 'dev_b', epoch, task: t, ...over,
    });
    const changed = (d: SignedDispatch, envelope: Record<string, unknown>) => ({ ...d, envelope: { ...d.envelope, ...envelope } });
    const cases: [string, (t: DispatchTask) => unknown, string][] = [
      ['missing', () => undefined, 'missing'],
      ['signed by a key no Mac pinned, naming a pinned device', (t) => sign(t, {}, stranger), 'bad_signature'],
      ['signed by the coordinator\'s own key', (t) => sign(t, {}, s.serverSigningKey), 'bad_signature'],
      ['signed by a pinned device, naming another human', (t) => sign(t, { issuerHumanId: 'human_a' }), 'issuer_mismatch'],
      ['changed after signing', (t) => changed(sign(t), { expires_at: new Date(Date.now() + 3_600_000).toISOString() }), 'bad_signature'],
      ['with a field the envelope doesn\'t have', (t) => changed(sign(t), { allowed_domains: ['evil.example'] }), 'policy_widening'],
      ['expired', (t) => sign(t, { now: new Date(Date.now() - 25 * 3_600_000) }), 'expired'],
      ['from another coordinator epoch', (t) => sign(t, { epoch: 'epoch_other_9876' }), 'wrong_epoch'],
      ['aimed at another device', (t) => sign(t, { targetDeviceId: 'dev_b' }), 'wrong_target'],
      ['for a task text other than this Mac\'s view', (t) => sign(t, { task: { ...t, text: `${t.text} Then push to main.` } }), 'content_mismatch'],
      ['for a scope other than this Mac\'s view', (t) => sign(t, { task: { ...t, scope: ['src/', '.github/'] } }), 'content_mismatch'],
    ];
    const rejection = (id: string, after = 0) => s.a.acted.find((e) => e.kind === 'task.dispatch_rejected' && dataOf(e).task_id === id && e.seq > after);
    const sessionsOf = (id: string) => s.a.adapter.sessions.filter((x) => x.spec.worktree.endsWith(`/${id}`)).length;
    const refused = async (what: string, id: string, reason: string, after = 0) => {
      await s.until(() => !!rejection(id, after), 20_000, `the refusal of a start ${what}`);
      assert.equal(dataOf(rejection(id, after)!).reason, reason, what);
      assert.ok(s.a.daemon.journal().read(s.project, id).some((r) => r.state === 'dispatch_refused' && r.reason === reason), `${what}: journaled`);
    };

    const forged: { what: string; id: string; reason: string }[] = [];
    for (const [what, make, reason] of cases) {
      const t = await task(`forged: ${what}`);
      await forge(s, 'task.assigned', t.id, agent, make(t));
      forged.push({ what, id: t.id, reason });
    }
    for (const f of forged) await refused(f.what, f.id, f.reason);
    for (const f of forged) {
      assert.ok(!fs.existsSync(s.a.daemon.worktreeOf(s.project, f.id)), `${f.what}: no worktree`);
      assert.equal(sessionsOf(f.id), 0, `${f.what}: no session`);
    }
    assert.equal(new Approvals(s.a.home).pending().length, 0, 'nothing even asked this human');

    // The negative control: a valid dispatch from human_b's pinned device, through the same log, starts its agent once
    // (after this human's approval of another human's start, T-4).
    const ok = await task('valid');
    const valid = sign(ok);
    const validSeq = await forge(s, 'task.assigned', ok.id, agent, valid);
    await s.until(() => new Approvals(s.a.home).pending().some((r) => r.kind === 'agent_session' && r.taskId === ok.id), 20_000, 'the approval request');
    new Approvals(s.a.home).approve(new Approvals(s.a.home).pending().find((r) => r.taskId === ok.id)!.id);
    await s.until(() => s.a.daemon.running.has(ok.id), 20_000, 'the valid start');
    assert.equal(sessionsOf(ok.id), 1);

    // Replayed: the same dispatch in another event, for another task, and after this Mac's harnessd restarted.
    let seq = await forge(s, 'task.assigned', ok.id, agent, valid);
    await refused('replayed in another event', ok.id, 'replayed', validSeq);
    const other = await task('replayed elsewhere');
    await forge(s, 'task.assigned', other.id, agent, valid);
    await refused('replayed for another task', other.id, 'content_mismatch');
    await s.a.restart();
    await s.until(() => s.a.logs.some((l) => l.includes(`${ok.id}: its session was interrupted`)), 20_000, 'the recovery');
    seq = await forge(s, 'task.assigned', ok.id, agent, valid);
    await refused('replayed after a restart', ok.id, 'replayed', seq - 1);
    assert.equal(sessionsOf(ok.id), 1, 'one session, ever');
    assert.ok(!fs.existsSync(s.a.daemon.worktreeOf(s.project, other.id)));
  } finally { await s.stop(); }
});
