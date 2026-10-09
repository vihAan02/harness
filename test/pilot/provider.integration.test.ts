// Provider failure and the day's budget (D-116, acceptance 7), with the real CLI against the scripted model:
// - a billing error stops every agent on the device, and keeps new ones from starting until the human resets the circuit;
// - repeated rate limits stop only the session that hit them;
// - the day's budget running out stops them all until the next UTC day.
// Every stopped task keeps its worktree, for its human to resume. Nothing switches provider.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startStack, steps, type Stack } from '../support.ts';

let s: Stack;
before(async () => { s = await startStack({ portRange: [32400, 32499], files: { 'src/a.ts': 'export const a = 1;\n' } }); });
after(async () => { await s?.stop(); });

const tasks: string[] = [];
afterEach(async () => {
  // A stopped task keeps its worktree and its slot (D-38): abandon each, so the next test can start its own.
  s.daemon.circuit.reset();
  for (const t of tasks.splice(0)) await s.command('task.abandon', { task_id: t, reason: 'test done' }).catch(() => {});
  await s.until(() => Object.keys(s.daemon.ports.list()).length === 0 && s.daemon.running.size === 0, 30_000, 'the slots to be free');
});
const assign = async (title: string, text: string) => { const t = await s.assignTask(await agent(), title, ['src/'], text); tasks.push(t); return t; };
const sessionOf = (task: string) => [...s.daemon.view(s.project).sessions.values()].filter((x) => x.taskId === task).at(-1);
let n = 0;
const agent = async () => (await s.command('agent.create', { name: `agent/p${++n}`, vendor: 'claude' })).agent_id!;

test('a billing error: the session stops as provider_billing, the circuit opens, and no agent starts until it\'s reset', async () => {
  s.daemon.circuit.reset();
  s.mock.failPlan = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }];
  const t1 = await assign('Billing', steps('TEXT never'));
  await s.until(() => sessionOf(t1)?.endReason === 'provider_billing', 60_000, 'the session to stop as provider_billing');
  s.mock.failPlan = [];
  assert.equal(s.daemon.circuit.state()?.kind, 'billing');
  assert.ok(fs.existsSync(s.worktreeOf(t1)), 'its worktree stays, for its human to resume');
  assert.deepEqual(s.daemon.health().provider_circuit && (s.daemon.health().provider_circuit as { kind: string }).kind, 'billing');
  // A new assignment is refused before anything starts.
  const t2 = await assign('Next', steps('TEXT next'));
  await s.until(() => s.logs.some((l) => l.includes('the provider circuit is open (billing')), 20_000, 'the refusal');
  assert.equal(sessionOf(t2), undefined, 'no session');
  assert.ok(!s.daemon.running.has(t2));
  s.daemon.circuit.reset();
});

test('repeated rate limits stop that session only, as rate_limited; the circuit stays closed', async () => {
  s.daemon.circuit.reset();
  const limited = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }, headers: { 'retry-after': '0' } };
  s.mock.failPlan = [limited, limited, limited, limited, limited];
  const t = await assign('Limited', steps('TEXT eventually'));
  await s.until(() => sessionOf(t)?.endReason === 'rate_limited', 90_000, 'the session to stop as rate_limited');
  s.mock.failPlan = [];
  assert.equal(s.daemon.circuit.state(), null, 'a rate limit is not the account\'s fault');
});

test('the day\'s budget: a session gets at most what\'s left; reaching the budget stops every agent until the next UTC day', async () => {
  s.daemon.circuit.reset();
  s.daemon.config.agents.dailyBudgetUsd = 1;
  try {
    s.daemon.spend.record('earlier-today', 0.96); // $0.04 left: enough to start
    assert.equal(s.daemon.sessionCap(s.daemon.spend.remaining(1))!.toFixed(2), '0.04', 'the session\'s cap is what\'s left of the day');
    const t = await assign('Budget', steps(`Bash ${JSON.stringify({ command: 'sleep 2' })}`, 'TEXT done'));
    await s.until(() => s.daemon.running.has(t), 30_000, 'the session');
    s.daemon.spend.record('elsewhere-today', 0.05); // another session's spend: the day is now over budget
    await s.until(() => sessionOf(t)?.endReason === 'budget', 60_000, 'the session to stop as budget');
    assert.equal(s.daemon.circuit.state()?.kind, 'budget');
    // Nothing more starts today; the refusal names the reason.
    const t2 = await assign('After', steps('TEXT after'));
    await s.until(() => s.logs.some((l) => l.includes('the provider circuit is open (budget')), 20_000, 'the refusal');
    assert.equal(sessionOf(t2), undefined);
  } finally {
    s.daemon.config.agents.dailyBudgetUsd = null;
    s.daemon.circuit.reset();
  }
});
