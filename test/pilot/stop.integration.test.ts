// Stopping harnessd (#74): a land's tests are killed at once and the land is interrupted; with the server unreachable,
// stop() still ends, within its deadline, and cleans up locally; what a kill left behind is cleaned at the next start,
// without destroying work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EventMessage } from '../../packages/protocol/src/index.ts';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { FakeAdapter } from '../fake-adapter.ts';
import { startStack } from '../support.ts';

const FILES = {
  'src/a.ts': 'export const a = 1;\n',
  'package.json': '{"name":"stop"}\n',
  'slow-land-test.mjs': 'setTimeout(() => {}, 600_000);\n', // the land's test: never finishes on its own
  'harness.yaml': 'test:\n  command: node slow-land-test.mjs\n  manifests: [package.json]\n',
};
const dataOf = (e: { data: unknown }) => e.data as Record<string, unknown>;
const pids = () => { try { return execFileSync('pgrep', ['-f', 'slow-land-test.mjs'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A stack whose task is done and whose land is running its (endless) tests. */
async function landing(extra: Record<string, unknown> = {}) {
  const fake = new FakeAdapter();
  const s = await startStack({ portRange: [32500, 32599], files: FILES, daemonOptions: { adapters: { claude: fake }, ...extra } });
  const approver = setInterval(() => { const a = new Approvals(s.home); for (const r of a.pending()) a.approve(r.id); }, 100);
  const agent = (await s.command('agent.create', { name: 'agent/stopper', vendor: 'claude' })).agent_id!;
  const task = await s.assignTask(agent, 'stopper', [], 'fake');
  await s.until(() => s.daemon.running.has(task), 30_000, 'the session');
  fs.writeFileSync(path.join(s.worktreeOf(task), 'src/a.ts'), 'export const a = 2;\n');
  fake.of(task).edited(['src/a.ts']);
  await s.command('task.complete', { task_id: task });
  await s.nextEvent((e) => e.kind === 'worktree.committed' && dataOf(e).task_id === task, 30_000);
  const land = (await s.command('land.request', { task_id: task })).land_id!;
  await s.nextEvent((e) => e.kind === 'land.progress' && dataOf(e).land_id === land && dataOf(e).step === 'testing', 60_000);
  await s.until(() => pids().length > 0, 10_000, 'the test process');
  return { s, task, land, approver, running: pids() };
}

test('a stop during a land\'s tests kills them at once, and the land is interrupted with the base untouched', async () => {
  const { s, land, approver, running } = await landing();
  try {
    const base = execFileSync('git', ['rev-parse', 'main'], { cwd: s.repo, encoding: 'utf8' }).trim();
    const t0 = Date.now();
    await s.daemon.stop();
    assert.ok(Date.now() - t0 < 15_000, `stopped in ${Date.now() - t0} ms, not after the test's timeout`);
    await s.until(() => running.every((p) => !alive(p)), 5000, 'the test processes to be gone');
    const failed = (await s.db.pool.query("SELECT data FROM events WHERE kind = 'land.failed' AND data->>'land_id' = $1", [land])).rows[0]?.data;
    assert.equal(failed?.reason, 'interrupted');
    assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: s.repo, encoding: 'utf8' }).trim(), base);
  } finally {
    clearInterval(approver);
    await s.stop();
  }
});

test('with the server unreachable, stop() still ends within its deadline and cleans up locally', async () => {
  const { s, land, approver, running } = await landing({ stopDeadlineMs: 1500 });
  try {
    await s.server.close();
    const t0 = Date.now();
    await s.daemon.stop();
    assert.ok(Date.now() - t0 < 14_000, `stopped in ${Date.now() - t0} ms`);
    await s.until(() => running.every((p) => !alive(p)), 5000, 'the test processes to be gone');
    assert.ok(!fs.existsSync(path.join(s.home.root, 'integration', s.project, land)), 'the integration checkout went');
    assert.ok(s.logs.some((l) => /still waiting after 2 s \(is the server unreachable\?\)/.test(l)), s.logs.slice(-5).join(' | '));
  } finally {
    clearInterval(approver);
    await s.stop().catch(() => {}); // the server is already closed
  }
});

test('the next start removes what a kill left behind, and keeps any work', async () => {
  const s = await startStack({ portRange: [32500, 32599], files: FILES, daemonOptions: { adapters: { claude: new FakeAdapter() } } });
  try {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();
    const base = git(s.repo, 'rev-parse', 'main');
    // An integration checkout and land scratch from a land that isn't running.
    const integration = path.join(s.home.root, 'integration', s.project, 'land_gone');
    fs.mkdirSync(path.dirname(integration), { recursive: true });
    git(s.repo, 'worktree', 'add', '-q', '--detach', integration, base);
    const scratch = path.join(s.home.scratch, s.project, 'land-land_gone');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'x'), 'x');
    // Three landed tasks whose worktrees a kill after the land kept: one clean and merged, one with an uncommitted
    // change, one whose branch has a commit the land didn't include.
    const wt = (t: string) => { const w = s.worktreeOf(t); fs.mkdirSync(path.dirname(w), { recursive: true }); git(s.repo, 'worktree', 'add', '-q', '-b', `harness/task/${t}`, w, base); return w; };
    const clean = wt('T-90');
    const dirty = wt('T-91');
    fs.writeFileSync(path.join(dirty, 'src/a.ts'), 'unsaved work\n');
    const ahead = wt('T-92');
    fs.writeFileSync(path.join(ahead, 'new.txt'), 'later\n');
    git(ahead, 'add', 'new.txt');
    git(ahead, 'commit', '-q', '-m', 'after the land');
    // The view's record of those lands (this device's, completed), as the log would have it.
    const view = s.daemon.view(s.project);
    let seq = view.head;
    const ev = (kind: string, data: Record<string, unknown>): EventMessage =>
      ({ v: 1, type: 'event', project_id: s.project, seq: ++seq, at: new Date().toISOString(), actor: { principal: 'human_test', on_behalf_of: null, device_id: 'dev_test' }, kind, data });
    for (const t of ['T-90', 'T-91', 'T-92']) {
      view.apply(ev('task.created', { task_id: t, title: t, text: t, scope: [], owner_human_id: 'human_test' }));
      view.apply(ev('land.requested', { land_id: `land_${t}`, task_id: t, device_id: 'dev_test' }));
      view.apply(ev('land.completed', { land_id: `land_${t}`, task_id: t, new_base_sha: base, changed_paths: [] }));
    }
    await s.daemon.cleanLeftovers();
    assert.ok(!fs.existsSync(integration), 'the integration checkout went');
    assert.ok(!git(s.repo, 'worktree', 'list').includes(integration), 'and Git forgot it');
    assert.ok(!fs.existsSync(scratch), 'the land scratch went');
    assert.ok(!fs.existsSync(clean), 'the clean, merged worktree went');
    assert.equal(fs.readFileSync(path.join(dirty, 'src/a.ts'), 'utf8'), 'unsaved work\n', 'uncommitted work is kept');
    assert.ok(fs.existsSync(path.join(ahead, 'new.txt')), 'a branch with commits the land didn\'t include is kept');
  } finally { await s.stop(); }
});
