// The coordinator this device serves (D-113): its epoch is saved with the event cursors. Another epoch (a new
// database) is refused until the human accepts it; then this device starts afresh, and the old coordinator's unsent
// reports go to the outbox's dead/, never to the new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Daemon } from '../src/daemon.ts';
import { parseConfig } from '../src/config.ts';
import { writeJsonAtomic } from '../src/home.ts';
import { ServerLink } from '../src/link.ts';
import { Outbox } from '../src/outbox.ts';
import { tempDir, tempHome, TOKEN } from './fixtures.ts';

function device(acceptCoordinator?: string) {
  const t = tempDir('epoch');
  const home = tempHome(t.dir);
  const config = parseConfig({ device_id: 'dev_test', principal: 'human_test', server_url: 'ws://127.0.0.1:1', projects: [{ id: 'prj', repo: t.dir }] }, TOKEN);
  const logs: string[] = [];
  const make = () => {
    const daemon = new Daemon({ home, config, log: (m) => logs.push(m), ...(acceptCoordinator ? { acceptCoordinator } : {}) });
    daemon.outbox = new Outbox(home.outbox);
    // Never started: acceptEpoch is what the link calls at a welcome.
    daemon.link = new ServerLink({ url: config.serverUrl, cursors: { prj: 0 }, onEvent: () => {}, outbox: daemon.outbox, handshake: () => { throw new Error('unused'); } });
    daemon.link.cursors = JSON.parse(fs.readFileSync(home.state, 'utf8')).cursors;
    return daemon;
  };
  const state = () => JSON.parse(fs.readFileSync(home.state, 'utf8')) as { epoch?: string; cursors: Record<string, number> };
  return { t, home, logs, make, state };
}
const report = (d: Daemon, id: string) => d.link!.command('prj', 'worktree.report', { task_id: 'T-1' }, undefined, id, true).catch(() => {});

test('the first epoch is adopted; the same one again passes; a null one (a 0B server) is never compared', () => {
  const x = device();
  try {
    writeJsonAtomic(x.home.state, { cursors: { prj: 7 } });
    const d = x.make();
    assert.equal(d.acceptEpoch('epoch_aaaaaaaa'), true);
    assert.deepEqual(x.state(), { epoch: 'epoch_aaaaaaaa', cursors: { prj: 7 } }, 'adopted, cursors kept');
    assert.equal(d.acceptEpoch('epoch_aaaaaaaa'), true);
    assert.equal(d.acceptEpoch(null), true);
    assert.equal(d.coordinatorChanged, null);
  } finally { x.t.cleanup(); }
});

test('another epoch is refused and nothing changes; accepted by the human, this device starts afresh with it', async () => {
  const x = device();
  try {
    writeJsonAtomic(x.home.state, { epoch: 'epoch_aaaaaaaa', cursors: { prj: 42 } });
    const d = x.make();
    void report(d, '11111111-1111-4111-8111-111111111111'); // a report for the old coordinator, still unsent
    assert.equal(d.acceptEpoch('epoch_bbbbbbbb'), false);
    assert.deepEqual(d.coordinatorChanged, { served: 'epoch_aaaaaaaa', seen: 'epoch_bbbbbbbb' });
    assert.deepEqual(x.state(), { epoch: 'epoch_aaaaaaaa', cursors: { prj: 42 } }, 'unchanged');
    assert.ok(x.logs.some((l) => l.includes('--accept-coordinator epoch_bbbbbbbb')), 'the human is told how to accept it');
    assert.equal(d.outbox!.pending(), 1, 'kept for the coordinator it was made for');
    await d.link!.stop();

    const y = device('epoch_bbbbbbbb');
    fs.rmSync(y.home.root, { recursive: true, force: true });
    fs.cpSync(x.home.root, y.home.root, { recursive: true }); // the same home, restarted with --accept-coordinator
    const accepted = y.make();
    assert.equal(accepted.link!.pending.size, 1, 'the old report was loaded');
    assert.equal(accepted.acceptEpoch('epoch_bbbbbbbb'), true);
    assert.deepEqual(y.state(), { epoch: 'epoch_bbbbbbbb', cursors: { prj: 0 } }, 'each project\'s log is read from the start');
    assert.equal(accepted.link!.pending.size, 0, 'never sent to the new coordinator');
    assert.equal(accepted.outbox!.pending(), 0);
    assert.deepEqual(accepted.outbox!.dead().map((e) => [e.name, e.error]), [['worktree.report', 'not sent: for coordinator epoch_aaaaaaaa, not epoch_bbbbbbbb']]);
    await accepted.link!.stop();
    y.t.cleanup();
  } finally { x.t.cleanup(); }
});
