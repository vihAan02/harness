// The durable outbox (D-113; outbox.ts): what's waiting survives a restart in order; answered ones go; refused and
// unreadable ones are kept apart for the human, never retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from '@harness/protocol';
import { Outbox } from '../src/outbox.ts';
import { tempDir } from './fixtures.ts';

const cmd = (id: string, name = 'worktree.report'): Command => ({ v: 1, type: 'command', command_id: id, project_id: 'prj', name, args: { task_id: 'T-1' } });

test('entries come back in the order they were made, across a restart; an answered one is gone', () => {
  const t = tempDir('outbox');
  try {
    const dir = path.join(t.dir, 'outbox');
    const a = new Outbox(dir);
    for (const id of ['c1', 'c2', 'c3']) a.put(cmd(id));
    a.remove('c2');
    const b = new Outbox(dir); // the next start
    assert.deepEqual(b.load().map((e) => e.msg.command_id), ['c1', 'c3']);
    assert.equal(b.pending(), 2);
    b.put(cmd('c4'));
    assert.deepEqual(new Outbox(dir).load().map((e) => e.msg.command_id), ['c1', 'c3', 'c4'], 'a new one goes after what was waiting');
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally { t.cleanup(); }
});

test('a refused entry, or one that can\'t be read, goes to dead/ with why; neither is sent again', () => {
  const t = tempDir('outbox');
  try {
    const dir = path.join(t.dir, 'outbox');
    const a = new Outbox(dir);
    a.put(cmd('c1', 'land.complete'));
    a.put(cmd('c2'));
    a.bury('c1', 'land.complete', 'conflict: land L-1 is already completed');
    fs.writeFileSync(path.join(dir, '000000000099-c9.json'), '{"n": 99, "msg": {"command_'); // a torn write
    fs.writeFileSync(path.join(dir, '000000000098-c8.json.123.tmp'), 'half'); // never renamed: never sent
    const b = new Outbox(dir);
    assert.deepEqual(b.load().map((e) => e.msg.command_id), ['c2']);
    assert.deepEqual(b.dead().map((d) => [d.name, d.command_id, d.error.split(':')[0]]), [['land.complete', 'c1', 'conflict'], ['?', 'c9', 'unreadable']]);
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
    assert.equal(b.put(cmd('c10')).n, 100, 'numbering goes on after the highest seen');
  } finally { t.cleanup(); }
});
