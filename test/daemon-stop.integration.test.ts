// harnessd's stop during a land (0B item 5; D-51). Daemon.stop() waits for the land in flight, so once it returns
// nothing of the land is still writing under ~/.harness or in the repo (the T-2 teardown flake: ENOTEMPTY).
//  - a land that moved the base reports it, then removes its worktrees and record, before the stop returns;
//  - one waiting for an approval gives up at once, as interrupted, and the server hears it before the link closes;
//  - one running its tests never moves the base once harnessd is stopping: interrupted too, as a restart would be;
//  - one not started yet is left as it is on the server, for recoverLands at the next start.
// Agents are fakes (test/fake-adapter.ts); the server, harnessd, Git and srt are real. Each test has its own stack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../packages/daemon/src/approvals.ts';
import { gitIn } from '../packages/daemon/test/fixtures.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { startStack, type Stack } from './support.ts';

const dataOf = (e: { data: unknown }) => e.data as Record<string, any>;
const FILES = {
  'src/a.ts': 'export const a = 1;\n',
  'package.json': '{"name":"daemon-stop"}\n',
  // The land's test: green once there's no file named hold (a task that adds one keeps its land testing).
  'check.mjs': "import fs from 'node:fs'; while (fs.existsSync('hold')) await new Promise((r) => setTimeout(r, 50)); console.log('green');\n",
  // A test command left holding (by a failed test) keeps harnessd's stop waiting a minute at most.
  'harness.yaml': 'test:\n  command: node check.mjs\n  manifests: [package.json]\n  timeout_seconds: 60\n',
};
/** What a land keeps under ~/.harness while it runs: its integration worktree, its test command's HOME and TMPDIR, its record. */
const leftovers = (s: Stack, landId: string) => [
  path.join(s.home.root, 'integration', s.project, landId), path.join(s.home.scratch, s.project, `land-${landId}`), path.join(s.home.root, 'lands', `${landId}.json`),
];
const progress = (s: Stack, landId: string, step: string) =>
  s.nextEvent((e) => e.kind === 'land.progress' && dataOf(e).land_id === landId && dataOf(e).step === step, 60_000);
const outcome = (s: Stack, landId: string, ms = 10_000) =>
  s.nextEvent((e) => (e.kind === 'land.completed' || e.kind === 'land.failed') && dataOf(e).land_id === landId, ms);

/** A stack of its own with one task finished and committed, then `body`, then the stack's stop (harnessd's second: harmless). */
async function withTask(o: { approve: boolean; files?: Record<string, string> }, body: (s: Stack, task: string) => Promise<void>) {
  const fake = new FakeAdapter();
  // No land here waits the default 30 minutes for an approval.
  const s = await startStack({ portRange: [31500, 31599], files: FILES, daemonOptions: { adapters: { claude: fake }, approvalTimeoutMs: 20_000 } });
  const approver = o.approve ? setInterval(() => { const a = new Approvals(s.home); for (const r of a.pending()) a.approve(r.id); }, 100) : undefined;
  try {
    const agent = (await s.command('agent.create', { name: 'agent/stopper', vendor: 'claude' })).agent_id!;
    const t = await s.assignTask(agent, 'stopper', [], 'fake');
    await s.until(() => fake.sessions.some((x) => x.spec.worktree.endsWith(`/${t}`)) && s.daemon.running.has(t), 30_000, `${t} to start`);
    const files = o.files ?? { 'src/a.ts': 'export const a = 2;\n' };
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(s.worktreeOf(t), f), c);
    fake.of(t).edited(Object.keys(files));
    await s.command('task.complete', { task_id: t });
    await s.nextEvent((e) => e.kind === 'worktree.committed' && dataOf(e).task_id === t, 30_000);
    await body(s, t);
  } finally {
    clearInterval(approver);
    await s.stop();
  }
}

test('a land that moved the base finishes before stop returns: nothing of it is left', async () => {
  await withTask({ approve: true }, async (s, t) => {
    // The land's cleanup after the server hears it landed is held back a moment, so the stop surely comes first.
    const realComplete = s.daemon.completeLand;
    let atLanded: boolean[] = [];
    s.daemon.completeLand = async (...args) => {
      await realComplete.apply(s.daemon, args);
      atLanded = leftovers(s, args[1]).map((p) => fs.existsSync(p));
      await new Promise((res) => setTimeout(res, 2000));
    };
    const r = await s.command('land.request', { task_id: t });
    const done = await outcome(s, r.land_id!, 60_000);
    assert.equal(done.kind, 'land.completed', JSON.stringify(dataOf(done)));
    await s.daemon.stop();
    assert.deepEqual(atLanded, [true, true, true], 'when the server heard, the land still had its worktree, scratch dir and record');
    for (const p of leftovers(s, r.land_id!)) assert.ok(!fs.existsSync(p), `${p} is gone once stop returns`);
    assert.ok(!fs.existsSync(s.worktreeOf(t)), 'and so is the landed task\'s worktree');
    assert.equal(gitIn(s.repo, 'rev-parse', 'main'), dataOf(done).new_base_sha);
  });
});

test('a land waiting for an approval gives up at once on stop, as interrupted, and the server hears it', async () => {
  await withTask({ approve: false }, async (s, t) => {
    const before = gitIn(s.repo, 'rev-parse', 'main');
    const r = await s.command('land.request', { task_id: t });
    await progress(s, r.land_id!, 'awaiting_approval');
    // A land queued behind it (a recovery, say) hasn't started: it's left for the next start.
    let ranQueued = false;
    s.daemon.queueLand(s.project, async () => { ranQueued = true; });
    const t0 = Date.now();
    await s.daemon.stop();
    const took = Date.now() - t0;
    const out = await outcome(s, r.land_id!);
    assert.deepEqual([out.kind, dataOf(out).reason], ['land.failed', 'interrupted'], JSON.stringify(dataOf(out)));
    assert.match(String(dataOf(out).detail), /stopped while waiting for approval/);
    assert.ok(took < 5000, `the stop took ${took} ms: it never waits out the approval`);
    assert.equal(ranQueued, false, 'the land queued behind it never started');
    assert.equal(gitIn(s.repo, 'rev-parse', 'main'), before, 'the base did not move');
    for (const p of leftovers(s, r.land_id!)) assert.ok(!fs.existsSync(p), `${p} is gone`);
  });
});

test('a land whose tests pass after harnessd began stopping never moves the base: interrupted, as a restart would be', async () => {
  await withTask({ approve: true, files: { 'src/a.ts': 'export const a = 3;\n', hold: '' } }, async (s, t) => {
    const before = gitIn(s.repo, 'rev-parse', 'main');
    const r = await s.command('land.request', { task_id: t });
    const hold = path.join(leftovers(s, r.land_id!)[0]!, 'hold');
    try {
      await progress(s, r.land_id!, 'testing');
      const stopping = s.daemon.stop(); // harnessd is stopping from here on (stop() says so at once)...
      fs.rmSync(hold); // ...and only then do the tests pass
      await stopping;
      await progress(s, r.land_id!, 'tested');
      const out = await outcome(s, r.land_id!);
      assert.deepEqual([out.kind, dataOf(out).reason], ['land.failed', 'interrupted'], JSON.stringify(dataOf(out)));
      assert.match(String(dataOf(out).detail), /stopped before the base moved/);
      assert.equal(gitIn(s.repo, 'rev-parse', 'main'), before, 'the base did not move');
      for (const p of leftovers(s, r.land_id!)) assert.ok(!fs.existsSync(p), `${p} is gone`);
    } finally {
      fs.rmSync(hold, { force: true }); // never leave the land's tests holding: the stack's stop would wait for them
    }
  });
});
