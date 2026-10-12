// A human's dispatch retried by its command_id (protocol.md §12, "pending until confirmed"): the UI resends a click
// whose answer it never got. harnessd resends exactly what it signed the first time, so the coordinator answers with the
// first outcome and the task is assigned once; a different request under the same command_id is refused. The control:
// a fresh command_id for the same start is a new command, which the coordinator judges on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { taskSha256 } from '../../packages/protocol/src/signing.ts';
import { startPilotStack } from '../support.ts';

test('a retried dispatch is applied once and answered with the first outcome; a reused command_id for another request is refused', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, portRanges: { a: [30200, 30249], b: [30250, 30299] } });
  try {
    const agent = (await s.a.command('agent.create', { name: 'agent/retry', vendor: 'claude' })).agent_id!;
    const task = (await s.a.command('task.create', { title: 'retry me', text: 'x', scope: [] })).task_id!;
    await s.until(() => s.a.daemon.view(s.project).tasks.has(task), 10_000, `${task} in harnessd's view`);
    const seen = s.a.daemon.view(s.project).tasks.get(task)!;
    const expected = { task_sha256: taskSha256({ title: seen.title, text: seen.text, scope: seen.scope, owner_human_id: seen.ownerHumanId }) };
    const id = randomUUID();
    const first = await s.a.daemon.dispatchCommand(s.project, 'start', task, { agentId: agent, expected }, id);
    const again = await s.a.daemon.dispatchCommand(s.project, 'start', task, { agentId: agent, expected }, id);
    assert.deepEqual(again.seqs, first.seqs, 'the retry gets the first outcome');
    const assigned = await s.db.pool.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND kind = 'task.assigned' AND data->>'task_id' = $2", [s.project, task]);
    assert.equal(assigned.rows[0].n, 1, 'assigned once');
    await assert.rejects(s.a.daemon.dispatchCommand(s.project, 'abandon', task, { reason: 'other', expected }, id), /already used for a different dispatch/);
    // The control: a new command_id is a new command, and the task is no longer open to start.
    await assert.rejects(s.a.daemon.dispatchCommand(s.project, 'start', task, { agentId: agent, expected }, randomUUID()), (e: Error) => !/already used/.test(e.message));
  } finally {
    await s.stop();
  }
});
