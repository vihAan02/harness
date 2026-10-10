// T-3, a forged command (security.md §8; D-112): the coordinator's registry is not this Mac's root of trust.
// A device the server registered for a human, but that this Mac never pinned (a tampered coordinator database, say),
// starts this human's agent. The server accepts the dispatch, since its registry says the key is fine; harnessd
// refuses it against its own pins, reports it, and the server frees the agent. Nothing ran.
// The server, both harnessds, Git and the fake GitHub are real; the agents are stand-ins (test/fake-adapter.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, parsePrivateKey } from '../../packages/protocol/src/signing.ts';
import type { LocalConfig } from '../../packages/daemon/src/config.ts';
import { dispatchFor } from '../../packages/server/test/helpers.ts';
import { openDeviceClient, startPilotStack } from '../support.ts';

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
