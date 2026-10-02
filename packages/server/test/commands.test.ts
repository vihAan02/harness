import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
before(async () => { db = await freshSchema(); });
after(async () => { await db?.drop(); });

const caller = { principal: 'human_test', deviceId: null };
const create = (project_id: string, command_id = randomUUID(), name = 'agent/a-1') =>
  ({ v: 1 as const, type: 'command' as const, command_id, project_id, name: 'agent.create', args: { name, vendor: 'claude' } });

test('ten simultaneous copies of one command run it exactly once', async () => {
  const p = await seedProject(db.pool);
  const cmd = create(p);
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => executeCommand(db.pool, caller, cmd)));
  assert.equal(outcomes.filter((o) => !o.duplicate).length, 1);
  assert.equal(new Set(outcomes.map((o) => JSON.stringify([o.seqs, o.result]))).size, 1, 'every copy reports the same outcome');
  const counts = (await db.pool.query(
    'SELECT (SELECT count(*) FROM agent_principals WHERE project_id = $1)::int AS agents, (SELECT count(*) FROM events WHERE project_id = $1)::int AS events', [p])).rows[0];
  assert.deepEqual(counts, { agents: 1, events: 1 });
});

test('a rejected command stores nothing, so a corrected retry with a new id works', async () => {
  const p = await seedProject(db.pool);
  await executeCommand(db.pool, caller, create(p));
  await assert.rejects(executeCommand(db.pool, caller, create(p)), (e) => e instanceof CommandError && e.code === 'conflict'); // name taken
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM commands WHERE project_id = $1', [p])).rows[0].n, 1);
  assert.equal((await db.pool.query('SELECT next_seq FROM projects WHERE id = $1', [p])).rows[0].next_seq, '1', 'the failed command left no seq gap');
});

test('unknown commands and bad arguments are rejected before anything is written', async () => {
  const p = await seedProject(db.pool);
  await assert.rejects(executeCommand(db.pool, caller, { ...create(p), name: 'task.explode' }), (e) => e instanceof CommandError && e.code === 'bad_request');
  await assert.rejects(executeCommand(db.pool, caller, create(p, randomUUID(), 'Bad Name')), (e) => e instanceof CommandError && e.code === 'bad_request');
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM commands WHERE project_id = $1', [p])).rows[0].n, 0);
});
