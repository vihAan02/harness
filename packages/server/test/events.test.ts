import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { inTransaction } from '../src/db.ts';
import { appendEvents, readEvents } from '../src/events.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
before(async () => { db = await freshSchema(); });
after(async () => { await db?.drop(); });

const ev = (kind: string, data?: unknown) => ({ kind, actor: 'human_test', data });

test('appended events get dense seqs from 1 and read back in order', async () => {
  const p = await seedProject(db.pool);
  assert.deepEqual(await inTransaction(db.pool, (tx) => appendEvents(tx, p, [ev('a', { n: 1 }), ev('b'), ev('c')])), [1, 2, 3]);
  assert.deepEqual(await inTransaction(db.pool, (tx) => appendEvents(tx, p, [ev('d')])), [4]);
  const all = await readEvents(db.pool, p, 0);
  assert.deepEqual(all.map((e) => [e.seq, e.kind]), [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
  assert.deepEqual(all[0]?.data, { n: 1 });
  assert.deepEqual((await readEvents(db.pool, p, 2)).map((e) => e.seq), [3, 4]);
});

test('seqs are per project', async () => {
  const [p, q] = [await seedProject(db.pool), await seedProject(db.pool)];
  await inTransaction(db.pool, (tx) => appendEvents(tx, p, [ev('a'), ev('b')]));
  assert.deepEqual(await inTransaction(db.pool, (tx) => appendEvents(tx, q, [ev('x')])), [1]);
});

test('refuses to append outside a transaction', async () => {
  const p = await seedProject(db.pool);
  const c = await db.pool.connect();
  try {
    await assert.rejects(appendEvents(c, p, [ev('x')]), /SAVEPOINT can only be used in transaction blocks/);
  } finally {
    c.release();
  }
  assert.deepEqual(await readEvents(db.pool, p, 0), []);
});

test('a rolled-back append leaves no gap', async () => {
  const p = await seedProject(db.pool);
  await assert.rejects(inTransaction(db.pool, async (tx) => { await appendEvents(tx, p, [ev('lost')]); throw new Error('boom'); }), /boom/);
  assert.deepEqual(await inTransaction(db.pool, (tx) => appendEvents(tx, p, [ev('kept')])), [1]);
});

test('a second writer waits for the first to commit, so seq order is commit order', async () => {
  const p = await seedProject(db.pool);
  const a = await db.pool.connect();
  await a.query('BEGIN');
  const [seqA] = await appendEvents(a, p, [ev('a')]);
  let bReturned = false;
  const b = inTransaction(db.pool, (tx) => appendEvents(tx, p, [ev('b')])).finally(() => { bReturned = true; });
  await sleep(300);
  assert.equal(bReturned, false, 'B got a seq while A still held the counter row');
  assert.deepEqual(await readEvents(db.pool, p, 0), [], 'uncommitted events must be invisible');
  await a.query('COMMIT');
  a.release();
  assert.deepEqual(await b, [seqA! + 1]);
});

test('a reader following its cursor during concurrent appends never sees a gap (F-56)', async () => {
  const p = await seedProject(db.pool);
  const N = 60;
  let writersDone = false;
  const writers = Promise.all(Array.from({ length: N }, async (_, i) => {
    await sleep(Math.random() * 50);
    await inTransaction(db.pool, async (tx) => {
      await appendEvents(tx, p, [ev('w', { i })]);
      await sleep(Math.random() * 15); // commit late, the case a bigserial cursor gets wrong
    });
  })).finally(() => { writersDone = true; });
  let cursor = 0;
  for (;;) {
    const finished = writersDone;
    const batch = await readEvents(db.pool, p, cursor);
    for (const e of batch) {
      assert.equal(e.seq, cursor + 1, `reader saw seq ${e.seq} right after ${cursor}`);
      cursor = e.seq;
    }
    if (finished && batch.length === 0) break;
    if (batch.length === 0) await sleep(2);
  }
  await writers;
  assert.equal(cursor, N);
});
