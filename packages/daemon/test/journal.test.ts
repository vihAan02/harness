// The write-ahead journal and the single-instance lock (D-113).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../src/journal.ts';
import { acquireLock, LockHeld } from '../src/lockfile.ts';
import { tempDir, tempHome } from './fixtures.ts';

test('the journal: appends in order, reads back, survives a torn last line, quarantines a corrupt file', () => {
  const t = tempDir('journal');
  try {
    const j = new Journal(tempHome(t.dir), 'ep0c0ffee');
    assert.deepEqual(j.read('prj_a', 'T-1'), []);
    j.append('prj_a', 'T-1', 'received', { seq: 3, kind: 'task.assigned' });
    j.append('prj_a', 'T-1', 'worktree', { base: 'a'.repeat(40) });
    assert.deepEqual(j.read('prj_a', 'T-1').map((r) => r.state), ['received', 'worktree']);
    assert.equal(j.last('prj_a', 'T-1', 'received')!.seq, 3);
    assert.ok(j.has('prj_a', 'T-1', 'worktree') && !j.has('prj_a', 'T-1', 'session'));
    assert.deepEqual(j.tasks(), [['prj_a', 'T-1']]);
    const file = j.file('prj_a', 'T-1');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.appendFileSync(file, '{"state":"sess'); // a crash mid-write
    assert.deepEqual(j.read('prj_a', 'T-1').map((r) => r.state), ['received', 'worktree']);
    fs.writeFileSync(file, '{"state":"received"}\nnot json\n{"state":"worktree"}\n');
    assert.deepEqual(j.read('prj_a', 'T-1'), [], 'a corrupt record: start from nothing, never crash-loop');
    assert.ok(!fs.existsSync(file));
    assert.equal(fs.readdirSync(j.quarantine).length, 1);
    assert.throws(() => j.file('prj_a', '../x'), /invalid journal key/);
    assert.throws(() => new Journal(tempHome(t.dir), '../etc'), /epoch/);
  } finally { t.cleanup(); }
});

test('the lock: one holder; a live holder refuses another; a dead holder\'s lock is taken over', async () => {
  const t = tempDir('lock');
  try {
    const file = path.join(t.dir, 'harnessd.lock');
    const release = await acquireLock(file);
    await assert.rejects(acquireLock(file), (e) => e instanceof LockHeld && e.pid === process.pid);
    release();
    assert.ok(!fs.existsSync(file));
    // A crashed holder: a pid that isn't running.
    fs.writeFileSync(file, JSON.stringify({ pid: 999_999, pidStart: 'Thu Jan  1 00:00:00 1970', at: 'x' }));
    const again = await acquireLock(file);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
    again();
    // An unreadable lock counts as stale.
    fs.writeFileSync(file, 'garbage');
    (await acquireLock(file))();
  } finally { t.cleanup(); }
});
