// T-2, a stale lease after sleep (validation.md §7; D-20, D-93, D-97), on one machine as Phase 0 allows: the
// LeaseKeeper's fault switch stands in for X's laptop going to sleep (renewal stops for X's task only)
// and X's agent process is stopped (SIGSTOP) past its lease's TTL. Everything else is real: the server,
// harnessd, the pinned Claude Code CLI (a scripted model), Git, srt for the land step's test command.
//  1. X holds a hard claim on lib/ (token n); harnessd renews it while X's device is awake.
//  2. X's device sleeps past the TTL.
//  3. Y claims lib/ (token n+1), changes a file under it, and the human lands Y.
//  4. X wakes, changes another file under lib/, finishes, and the human lands X: harnessd presents X's old
//     token n, as a stale holder would.
// Pass: the land step rejects X's change (stale_token), and the base branch doesn't move. Required: 100%.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { startStack, steps, type Stack } from '../support.ts';

let s: Stack;
let approver: NodeJS.Timeout;
const asleep = new Set<string>(); // tasks whose device "sleeps": the fault switch (T-2)

before(async () => {
  s = await startStack({
    portRange: [31800, 31899],
    daemonOptions: { faults: { leases: { suspendRenewal: (task) => asleep.has(task) } } },
    files: {
      'lib/index.ts': 'export {};\n',
      'package.json': '{"name":"t2"}\n',
      'check.mjs': "console.log('green');\n",
      'harness.yaml': 'test:\n  command: node check.mjs\n  manifests: [package.json]\n',
    },
  });
  approver = setInterval(() => { const a = new Approvals(s.home); for (const r of a.pending()) a.approve(r.id); }, 100);
});
after(async () => {
  clearInterval(approver);
  await s?.stop();
});

const landOutput = (task: string) => s.cli('land', task).then((out) => out, (e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`);

test('T-2: a lease that expired while its device slept can\'t land over the newer holder\'s', async () => {
  const view = s.daemon.view(s.project);
  const x = (await s.command('agent.create', { name: 'agent/x', vendor: 'claude' })).agent_id!;
  const y = (await s.command('agent.create', { name: 'agent/y', vendor: 'claude' })).agent_id!;

  // 1. X claims lib/ with a 10 s lease and writes a file under it; harnessd keeps the lease renewed. Once it's
  //    woken (step 4), X writes another file under lib/ and reports done.
  const tX = await s.nextTaskId();
  await s.assignTask(x, 'X', ['lib/'], steps(
    'mcp__harness__claim {"paths":["lib/"],"ttl_s":10}',
    `Write {"file_path":"${s.worktreeOf(tX)}/lib/a.ts","content":"export const a = 'x';\\n"}`,
    'TEXT X is waiting.',
    `Write {"file_path":"${s.worktreeOf(tX)}/lib/a2.ts","content":"export const a2 = 'x after waking';\\n"}`,
    'mcp__harness__report_done {"summary":"lib/a.ts and lib/a2.ts"}',
    'TEXT done'));
  await s.turnEnds(tX);
  const xLease = view.currentLeases(tX)[0]!;
  assert.equal(xLease.path, 'lib/');
  await s.until(() => view.events.some((e) => e.kind === 'lease.renewed' && (e.data as { task_id: string }).task_id === tX), 10_000, "harnessd to renew X's lease");

  // 2. X's device sleeps: renewal stops for X's task, and X's agent process is stopped, past the TTL.
  asleep.add(tX);
  const pid = s.daemon.running.get(tX)?.record.pid;
  assert.ok(pid, "X's agent process id is known");
  process.kill(pid, 'SIGSTOP');
  let tY = '';
  try {
    await s.until(() => Date.now() > Date.parse(view.leases.get(xLease.id)!.expiresAt) + 1000, 20_000, "X's lease to pass its TTL");

    // 3. Y claims lib/ (granted: X's lease has expired, on the server's clock), changes a file under it, finishes; the human lands Y.
    tY = await s.nextTaskId();
    await s.assignTask(y, 'Y', ['lib/'], steps(
      'mcp__harness__claim {"paths":["lib/"],"ttl_s":60}',
      `Write {"file_path":"${s.worktreeOf(tY)}/lib/b.ts","content":"export const b = 'y';\\n"}`,
      'mcp__harness__report_done {"summary":"lib/b.ts"}',
      'TEXT done'));
    await s.until(() => view.events.some((e) => e.kind === 'worktree.committed' && (e.data as { task_id: string }).task_id === tY), 60_000, 'Y to finish');
    const yLease = [...view.leases.values()].find((l) => l.taskId === tY)!;
    assert.ok(yLease.token > xLease.token, `Y's token ${yLease.token} is newer than X's ${xLease.token}`);
    assert.ok(view.leases.get(xLease.id)!.expiredAt, "X's lease was logged as expired when Y's claim saw it");
    assert.match(await landOutput(tY), new RegExp(`Landed ${tY}`));
  } finally {
    // 4. X wakes up.
    process.kill(pid, 'SIGCONT');
    asleep.delete(tX);
  }
  const baseAfterY = [...view.lands.values()].find((l) => l.taskId === tY && l.status === 'completed')!.newBaseSha!;

  // X carries on where it left off: a human nudge opens its next turn, it changes lib/ again and finishes.
  await s.command('message.send', { kind: 'question', to: x, text: 'Are you still on lib/? Carry on.' });
  await s.until(() => view.events.some((e) => e.kind === 'worktree.committed' && (e.data as { task_id: string }).task_id === tX), 60_000, "X's work to be committed");
  assert.ok(view.events.some((e) => e.kind === 'claim.observed' && (e.data as { task_id: string; paths: string[] }).task_id === tX && (e.data as { paths: string[] }).paths.includes('lib/a2.ts')), 'X changed lib/a2.ts after waking');
  assert.deepEqual(s.daemon.leases.tokens(s.project, tX), [{ lease_id: xLease.id, token: xLease.token }], 'harnessd presents X\'s old token n at land');
  const out = await landOutput(tX);

  // Pass: the land step rejects X's change, and the base doesn't move.
  assert.match(out, /Rejected by the fencing check:\n  lib\/a\.ts: stale_token/);
  const rejected = view.events.find((e) => e.kind === 'land.rejected' && (e.data as { task_id: string }).task_id === tX)!;
  assert.deepEqual((rejected.data as { problems: { path: string; reason: string; token: number; highest: number }[] }).problems.map((p) => [p.path, p.reason, p.token]).sort(),
    [['lib/a.ts', 'stale_token', xLease.token], ['lib/a2.ts', 'stale_token', xLease.token]]);
  assert.ok(!view.events.some((e) => e.kind === 'land.completed' && (e.data as { task_id: string }).task_id === tX), 'X never landed');
  assert.equal(execFileSync('git', ['-C', s.repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(), baseAfterY, "main is still Y's land");
});

test('control: while X\'s device is awake, harnessd renews its lease past the TTL, so Y\'s claim is refused', async () => {
  const view = s.daemon.view(s.project);
  const x = (await s.command('agent.create', { name: 'agent/x2', vendor: 'claude' })).agent_id!;
  const y = (await s.command('agent.create', { name: 'agent/y2', vendor: 'claude' })).agent_id!;
  const tX = await s.assignTask(x, 'X awake', ['pkg/'], steps('mcp__harness__claim {"paths":["pkg/"],"ttl_s":10}', 'TEXT X is waiting.'));
  await s.turnEnds(tX);
  const xLease = view.currentLeases(tX)[0]!;
  const firstExpiry = Date.parse(xLease.expiresAt);
  await s.until(() => Date.now() > firstExpiry + 1000, 20_000, "X's first expiry to pass");
  assert.ok(Date.parse(view.leases.get(xLease.id)!.expiresAt) > Date.now(), 'renewed: still current past its first expiry');
  const tY = await s.assignTask(y, 'Y refused', ['pkg/'], steps('mcp__harness__claim {"paths":["pkg/"]}', 'TEXT Y is waiting.'));
  await s.turnEnds(tY);
  assert.match(s.toolResults('Y refused')[0]!, new RegExp(`^Not granted: pkg/ overlaps a lease of ${tX} until`));
  for (const t of [tX, tY]) await s.command('task.abandon', { task_id: t, reason: 'control done' });
  await s.until(() => [tX, tY].every((t) => view.events.some((e) => e.kind === 'worktree.removed' && (e.data as { task_id: string }).task_id === t)), 30_000, 'harnessd to stop both');
});

test('negative control: without hard claims, the same timeline lands X\'s change (the fencing check is what stops it)', async () => {
  const view = s.daemon.view(s.project);
  const x = (await s.command('agent.create', { name: 'agent/x3', vendor: 'claude' })).agent_id!;
  const y = (await s.command('agent.create', { name: 'agent/y3', vendor: 'claude' })).agent_id!;
  const committed = (task: string) => view.events.some((e) => e.kind === 'worktree.committed' && (e.data as { task_id: string }).task_id === task);
  const tX = await s.nextTaskId();
  await s.assignTask(x, 'X no lease', ['src/'], steps(`Write {"file_path":"${s.worktreeOf(tX)}/src/c.ts","content":"export const c = 1;\\n"}`, 'TEXT X is waiting.'));
  await s.turnEnds(tX);
  const tY = await s.nextTaskId();
  await s.assignTask(y, 'Y no lease', ['src/'], steps(`Write {"file_path":"${s.worktreeOf(tY)}/src/d.ts","content":"export const d = 1;\\n"}`, 'mcp__harness__report_done {}', 'TEXT done'));
  await s.until(() => committed(tY), 60_000, 'Y to finish');
  assert.match(await landOutput(tY), new RegExp(`Landed ${tY}`));
  await s.cli('task', 'done', tX);
  await s.until(() => committed(tX), 60_000, "X's work to be committed");
  assert.match(await landOutput(tX), new RegExp(`Landed ${tX}`), 'with no leases, nothing rejects it');
});
