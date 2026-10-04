// High-priority notices through the hooks (D-99), against the real pinned Claude Code CLI and the scripted
// mock. While a turn runs, a queued notice rides the next tool batch's results as PostToolBatch context
// (F-106); otherwise, or when it's too long to attach whole, it's injected like any message, which the CLI
// frames mid-turn as "The user sent a new message" (C-14).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter, type ClaudeSession } from '../src/index.ts';
import { NOTICE_CONTEXT_CAP } from '../src/claude/hooks.ts';
import { collect, fixture, script, type Fixture } from './fixtures.ts';

const live: ClaudeSession[] = [];
const adapter = new (class extends ClaudeAdapter {
  override open(...args: Parameters<ClaudeAdapter['open']>) {
    const s = super.open(...args);
    live.push(s);
    return s;
  }
})();
let f: Fixture;
let bodies: { messages: { role: string; content: unknown }[] }[] = [];
before(async () => {
  f = await fixture();
  f.mock.onMain = (body) => bodies.push(body);
});
after(async () => {
  await Promise.all(live.map((s) => s.stop('kill')));
  await f.cleanup();
});

const human = (id: string, text: string) => ({ id, origin: 'human' as const, text });
const notice = (id: string, body = '') => ({ id, origin: 'coordinator' as const, text: `[harness notice] ${id} ${body}`.trimEnd() });
/** A notice exactly `n` characters long. */
const sized = (id: string, n: number) => ({ id, origin: 'coordinator' as const, text: `[harness notice] ${id} `.padEnd(n, 'x') });
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : (content as { type: string; text?: string; content?: unknown }[]).map((b) => b.text ?? (b.content === undefined ? '' : textOf(b.content))).join('\n');
/** The messages after the model's last turn in a request: the tool results, and what came with them. */
const tail = (body: (typeof bodies)[number]) => {
  const i = body.messages.findLastIndex((m) => m.role === 'assistant');
  const rest = body.messages.slice(i + 1);
  return { system: rest.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'), user: rest.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n') };
};
/** The request that sent the model a tool result with exactly this text. */
const after_ = (result: string) => {
  const hit = bodies.find((b) => tail(b).user.split('\n').includes(result));
  assert.ok(hit, `no request carried the tool result ${result}`);
  return tail(hit);
};
const settle = <T>(p: Promise<T>, ms = 15_000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('never settled')), ms))]);

test('queued notices ride the next tool batch, oldest first, as many as fit in 10,000 characters (D-99, F-106)', async () => {
  bodies = [];
  const h = await adapter.startSession(f.spec(), human('m1', script('Bash {"command":"sleep 2; echo first"}', 'Bash {"command":"echo second"}', 'TEXT done')));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'tool.called');
  const t0 = Date.now();
  // n1 and n2 fit together; n3 would take them past the cap, so it waits for the next batch.
  const queued = [notice('n1', 'short'), notice('n2', 'B'.repeat(6000)), notice('n3', 'C'.repeat(6000))];
  assert.ok(queued[0]!.text.length + queued[1]!.text.length + 2 <= NOTICE_CONTEXT_CAP);
  assert.ok(queued[1]!.text.length + queued[2]!.text.length + 2 > NOTICE_CONTEXT_CAP);
  const [r1, r2, r3] = await settle(Promise.all(queued.map((n) => adapter.queueNotice(h, n))));
  for (const r of [r1, r2, r3]) assert.equal(r!.landed, 'between_tools');
  assert.ok(r1!.deliveredAt - t0 >= 1000, 'attached when the running tool finished; never interrupted it');
  assert.ok(r3!.deliveredAt >= r2!.deliveredAt);
  await c.turns(1);

  const first = after_('first');
  assert.ok(first.system.startsWith(`PostToolBatch hook additional context: ${queued[0]!.text}\n\n${queued[1]!.text}`), first.system.slice(0, 200));
  assert.ok(!first.system.includes('[harness notice] n3'), 'n3 did not fit with the others');
  assert.ok(!first.user.includes('[harness notice]') && !first.system.includes('The user sent a new message'), 'hook context, never framed as the user\'s');
  const second = after_('second');
  assert.ok(second.system.startsWith(`PostToolBatch hook additional context: ${queued[2]!.text}`), 'n3, whole, after the next batch');
  assert.ok(!second.system.includes('[harness notice] n1'), 'nothing twice');
  const final = JSON.stringify(bodies.at(-1)!.messages);
  for (const n of queued) assert.equal(final.split(`[harness notice] ${n.id} `).length - 1, 1, `${n.id} reached the model exactly once`);
  assert.deepEqual(c.of('delivery').map((d) => [d.messageId, d.landed]), [['m1', 'new_turn'], ['n1', 'between_tools'], ['n2', 'between_tools'], ['n3', 'between_tools']]);
  await adapter.stopSession(h, 'graceful');
});

test('the cap is exact: a notice of 10,000 characters arrives whole, and two that pass it only with the separator go separately (F-106)', async () => {
  bodies = [];
  const h = await adapter.startSession(f.spec(), human('m1', script('Bash {"command":"sleep 2; echo b1"}', 'Bash {"command":"echo b2"}', 'Bash {"command":"echo b3"}', 'TEXT done')));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'tool.called');
  const [exact, a, b] = [sized('exact', NOTICE_CONTEXT_CAP), sized('a', 4999), sized('b', 5001)];
  assert.equal(a.text.length + b.text.length, NOTICE_CONTEXT_CAP, 'they fit together only without the separator');
  const receipts = await settle(Promise.all([exact, a, b].map((n) => adapter.queueNotice(h, n))));
  assert.deepEqual(receipts.map((r) => r.landed), ['between_tools', 'between_tools', 'between_tools']);
  await c.turns(1);
  assert.equal(after_('b1').system.split('\n')[0], `PostToolBatch hook additional context: ${exact.text}`, 'whole, and alone');
  assert.equal(after_('b2').system.split('\n')[0], `PostToolBatch hook additional context: ${a.text}`);
  assert.equal(after_('b3').system.split('\n')[0], `PostToolBatch hook additional context: ${b.text}`);
  const all = JSON.stringify(bodies);
  assert.ok(!all.includes('persisted-output') && !all.includes('Output too large'), 'the CLI never had to cut one short');
  await adapter.stopSession(h, 'graceful');
});

test('a message injected after a queued notice never overtakes it', async () => {
  bodies = [];
  const h = await adapter.startSession(f.spec(), human('m1', '#SLOW 2000\n#STEP TEXT first answer'));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'turn.started');
  await new Promise((r) => setTimeout(r, 300)); // the model is answering, and calls no more tools
  const queued = adapter.queueNotice(h, notice('n1'));
  const m2 = adapter.injectMessage(h, human('m2', '[harness message] m2\n#STEP TEXT second answer'));
  const [r1, r2] = await settle(Promise.all([queued, m2]));
  assert.ok(r1.deliveredAt <= r2.deliveredAt);
  await c.turns(1);
  await c.until(() => bodies.some((b) => JSON.stringify(b).includes('second answer')));
  const first = bodies.find((b) => JSON.stringify(b).includes('[harness message] m2'))!;
  const text = JSON.stringify(first);
  assert.ok(text.includes('[harness notice] n1') && text.indexOf('[harness notice] n1') < text.indexOf('[harness message] m2'), 'the notice went first, in the same request');
  await adapter.stopSession(h, 'graceful');
});

test('a notice is injected instead when it is too long to attach, the session is idle, or the turn ends first; one replaced while queued is withdrawn', async () => {
  bodies = [];
  // No Stop gate here (the task isn't in progress), so a notice the turn ends before takes the turn-end path.
  // stopgate.test.ts covers the gate.
  const h = await adapter.startSession(f.spec({ taskOpen: () => false }), human('m1', script('Bash {"command":"sleep 2; echo one"}', 'TEXT done')));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'tool.called');
  const big = notice('big', 'x'.repeat(NOTICE_CONTEXT_CAP));
  const bigReceipt = adapter.queueNotice(h, big);
  const stale = adapter.queueNotice(h, notice('stale'));
  assert.equal(adapter.withdrawNotice(h, 'stale'), true);
  assert.equal(adapter.withdrawNotice(h, 'stale'), false, 'once');
  await assert.rejects(settle(stale), /withdrawn/);
  assert.equal((await settle(bigReceipt)).landed, 'between_tools');
  await c.turns(1);
  const one = after_('one');
  assert.ok(one.system.includes(`The user sent a new message while you were working:\n${big.text}`), 'too long for hook context: injected, and landed with the tool result (SP-02)');
  assert.ok(!one.system.includes('PostToolBatch hook additional context'));
  assert.ok(!JSON.stringify(bodies).includes('[harness notice] stale'), 'the withdrawn notice never reached the model');

  // Idle: injected at once, and it opens a turn.
  const idle = await settle(adapter.queueNotice(h, notice('idle', '\n#STEP TEXT ok-idle')));
  assert.equal(idle.landed, 'new_turn');
  await c.turns(2);

  // A turn that ends without another tool batch: the queued notice opens the next turn.
  void adapter.injectMessage(h, human('m2', '#SLOW 1500\n#STEP TEXT slow answer'));
  await c.until(() => c.of('turn.started').length >= 3);
  const late = await settle(adapter.queueNotice(h, notice('late', '\n#STEP TEXT ok-late')));
  assert.equal(late.landed, 'new_turn');
  await c.turns(4);
  // The notice opened the next turn at once: harnessd never saw the session idle in between.
  const ends = c.seen.filter((o) => o.kind === 'turn.ended' || (o.kind === 'status' && o.status === 'idle'));
  const firstEnd = ends.findIndex((o) => o.kind === 'turn.ended');
  assert.deepEqual(ends.slice(firstEnd).map((o) => o.kind === 'status' ? 'idle' : 'end'), ['end', 'idle', 'end', 'idle', 'end', 'end', 'idle']);
  const last = tail(bodies.at(-1)!);
  assert.ok(last.user.includes('[harness notice] late'), 'injected as a message');

  // A session that ends with a notice still queued: its receipt fails, so harnessd delivers it to the next session.
  void adapter.injectMessage(h, human('m3', script('Bash {"command":"sleep 5"}', 'TEXT done')));
  await c.until(() => c.of('tool.called').length >= 2);
  const gone = adapter.queueNotice(h, notice('gone'));
  await adapter.stopSession(h, 'kill');
  await assert.rejects(settle(gone), /ended before the notice was delivered/);
  assert.deepEqual(c.of('delivery').map((d) => [d.messageId, d.landed]), [['m1', 'new_turn'], ['big', 'between_tools'], ['idle', 'new_turn'], ['m2', 'new_turn'], ['late', 'new_turn'], ['m3', 'new_turn']]);
});
