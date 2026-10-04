// Hard claims end to end (0B item 5; D-97): an agent claims a folder through its `claim` tool and sees
// it in harness_status; a human takes part of it over with `harness claim --force`; the agent is told,
// at its next safe boundary; `harness status` shows the new holder; `harness release` ends it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, steps, type Stack } from './support.ts';

let s: Stack;
before(async () => { s = await startStack({ files: { 'lib/util.ts': 'export {}\n', 'lib/index.ts': 'export {}\n' } }); });
after(async () => { await s?.stop(); });

test('hard claims end to end: an agent claims through its tool, a human takes it over with the CLI, the agent is told', async () => {
  const x = (await s.command('agent.create', { name: 'agent/lx', vendor: 'claude' })).agent_id!;
  const y = (await s.command('agent.create', { name: 'agent/ly', vendor: 'claude' })).agent_id!;
  const tX = await s.assignTask(x, 'Library', ['lib/'], steps(
    'mcp__harness__claim {"paths":["lib/"],"ttl_s":60}',
    'mcp__harness__harness_status {}',
    'TEXT done'));
  await s.turnEnds(tX);
  const results = s.toolResults('Library');
  assert.match(results[0]!, /^Granted:\n- lib\/: lease ls_[0-9a-f]{16}, token \d+, renewed by the harness/);
  assert.match(results[1]!, /Your hard claims: lib\/ \(ls_[0-9a-f]{16}, token \d+, until \d\d:\d\d:\d\d UTC\)/);
  const view = s.daemon.view(s.project);
  const xLease = view.currentLeases(tX)[0]!;

  const tY = await s.assignTask(y, 'Helper', ['lib/util.ts'], steps('TEXT ready'));
  await s.turnEnds(tY);
  const refused = await s.cli('claim', tY, 'lib/util.ts').then(() => 'granted?', (e: { stdout?: string }) => String(e.stdout)); // exit code 1
  assert.match(refused, new RegExp(`^Not granted\\. lib/util\\.ts overlaps lease ${xLease.id} of ${tX} \\(until \\d\\d:\\d\\d:\\d\\d UTC\\)\\. Take it over with --force\\.`));
  // Flag first: --force never swallows a path.
  assert.match(await s.cli('claim', tY, '--force', 'lib/util.ts'), new RegExp(`${tY} holds lib/util\\.ts: lease ls_[0-9a-f]{16}, token ${xLease.token + 1},`));
  await s.until(() => view.leases.get(xLease.id)?.releaseReason === 'revoked', 10_000, 'the revoke to reach harnessd');
  const told = [...view.messages.values()].find((m) => m.kind === 'claim_conflict' && m.to === x && m.data.revoked === true);
  assert.match(told!.text, new RegExp(`^lib/: your hard claim was taken over by human_test for task ${tY}\\.`));
  await s.until(() => !!view.messages.get(told!.id)?.deliveredAt, 15_000, 'the revoke notice to reach agent/lx');

  assert.match(await s.cli('status'), new RegExp(`${tY} "Helper"[^\\n]*\\n      scope: lib/util\\.ts\\n      changing: none\\n      hard claims: lib/util\\.ts \\(ls_`));
  // Every path given is claimed (spaces or commas); a bare --ttl is refused; release only takes the task's own ids.
  assert.equal((await s.cli('claim', tY, 'lib/x.ts', 'lib/y.ts,lib/z.ts')).split('\n').filter((l) => l.startsWith(`${tY} holds`)).length, 3);
  const fails = (...args: string[]) => s.cli(...args).then(() => 'succeeded?', (e: { stderr?: string }) => String(e.stderr));
  assert.match(await fails('claim', tY, 'lib/w.ts', '--ttl'), /--ttl needs a number of seconds/);
  assert.match(await fails('release', tY, xLease.id), new RegExp(`${xLease.id} is not a lease of ${tY}`));
  assert.equal(view.leases.get(xLease.id)?.releaseReason, 'revoked', "X's lease wasn't touched by that release");
  assert.match(await s.cli('release', tY), /^Released (ls_[0-9a-f]{16}(, )?){4}\.$/m);
  await s.until(() => view.currentLeases(tY).length === 0, 10_000, 'the release to reach harnessd');
  await Promise.all([s.daemon.stopAgent(tX), s.daemon.stopAgent(tY)]);
});
