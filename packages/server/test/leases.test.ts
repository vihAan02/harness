// Hard claims (0B item 5; contract D-97). Stream B builds the lease commands and replaces the stub test
// below with their real tests (D-94). The lease lock is used by land.complete already.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import type { HandlerContext } from '../src/handler.ts';
import { lockLeases } from '../src/leases.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
const human = { principal: 'human_test', deviceId: null };
const cmd = (name: string, args: Record<string, unknown>) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args });

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
});
after(async () => { await db?.drop(); });

test('the lease commands are registered, and refuse until they are built', async () => {
  for (const name of ['lease.acquire', 'lease.renew', 'lease.release']) {
    await assert.rejects(executeCommand(db.pool, human, cmd(name, {})), (e) => e instanceof CommandError && e.code === 'bad_request' && /not available yet/.test(e.message));
  }
});

test('the lease lock is per project and held until the transaction ends (D-97)', async () => {
  const a = await db.pool.connect();
  const b = await db.pool.connect();
  const tryLock = async (projectId: string) =>
    (await b.query("SELECT pg_try_advisory_xact_lock(hashtext('harness.leases:' || $1)) AS ok", [projectId])).rows[0].ok as boolean;
  try {
    await a.query('BEGIN');
    await lockLeases({ tx: a, projectId: project } as unknown as HandlerContext);
    await b.query('BEGIN');
    assert.equal(await tryLock(project), false, 'held by the first transaction');
    assert.equal(await tryLock(`${project}_other`), true, 'another project is not blocked');
    await b.query('ROLLBACK');
    await a.query('COMMIT');
    await b.query('BEGIN');
    assert.equal(await tryLock(project), true, 'released at commit');
    await b.query('ROLLBACK');
  } finally {
    a.release();
    b.release();
  }
});
