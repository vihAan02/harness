// The Stop gate (D-100), against the real pinned Claude Code CLI and the scripted mock. When the agent is about
// to end its turn with high-priority notices still queued and its task in progress, the notices keep it going,
// as Stop hook context (F-107), at most STOP_CAP times in a row; past that they open the next turn (D-99).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter, type ClaudeSession } from '../src/index.ts';
import { STOP_CAP } from '../src/claude/hooks.ts';
import { collect, fixture, type Fixture } from './fixtures.ts';

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
const notice = (id: string, size = 0) => ({ id, origin: 'coordinator' as const, text: `[harness notice] ${id} `.padEnd(size, 'x') });
const settle = <T>(p: Promise<T>, ms = 20_000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('never settled')), ms))]);
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : (content as { text?: string }[]).map((b) => b.text ?? '').join('\n');
/** Every message the model was sent that carries this notice, as role and text. */
const carrying = (id: string) => {
  const last = bodies.at(-1)!;
  return last.messages.filter((m) => textOf(m.content).includes(`[harness notice] ${id} `)).map((m) => ({ role: m.role, text: textOf(m.content) }));
};

test('a notice still queued when the agent stops keeps it going, as Stop hook context, within the same turn (D-100, F-107)', async () => {
  bodies = [];
  const h = await adapter.startSession(f.spec(), human('m1', '#SLOW 1500\n#STEP TEXT first answer\n#STEP TEXT after the notice'));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'turn.started');
  await new Promise((r) => setTimeout(r, 300)); // the model is answering, and calls no tools: no batch will take it
  const r = await settle(adapter.queueNotice(h, notice('n1')));
  assert.equal(r.landed, 'stop_hook');
  await c.turns(1);
  const seen = carrying('n1');
  assert.equal(seen.length, 1, 'once');
  assert.equal(seen[0]!.role, 'user');
  assert.ok(seen[0]!.text.startsWith('<system-reminder>\nStop hook additional context: [harness notice] n1'), seen[0]!.text.slice(0, 120));
  assert.ok(!JSON.stringify(bodies).includes('Stop hook feedback'), 'additionalContext, never a block reason');
  assert.ok(JSON.stringify(bodies.at(-1)).includes('first answer'), 'the agent carried on from its answer');
  assert.equal(c.of('turn.ended').length, 1, 'one turn: the gate kept it going, no new turn');
  const fromStart = c.seen.slice(c.seen.findIndex((o) => o.kind === 'turn.started'));
  assert.equal(fromStart.filter((o) => o.kind === 'status' && o.status === 'idle').length, 1, 'idle only at the very end');
  await adapter.stopSession(h, 'graceful');
});

test('no gate once the task is no longer in progress: the notice opens the next turn instead', async () => {
  bodies = [];
  let open = true;
  const h = await adapter.startSession(f.spec({ taskOpen: () => open }), human('m1', '#SLOW 1500\n#STEP TEXT first answer'));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'turn.started');
  open = false; // e.g. the agent called report_done
  await new Promise((r) => setTimeout(r, 300));
  const r = await settle(adapter.queueNotice(h, { id: 'n2', origin: 'coordinator', text: '[harness notice] n2 \n#STEP TEXT ok' }));
  assert.equal(r.landed, 'new_turn');
  await c.turns(2);
  assert.ok(!carrying('n2').some((m) => m.text.includes('Stop hook additional context')));
  assert.equal(c.of('stop.capped').length, 0);
  await adapter.stopSession(h, 'graceful');
});

test(`at most ${STOP_CAP} continuations in a row: then the adapter reports the cap, and the rest open the next turn`, async () => {
  bodies = [];
  const h = await adapter.startSession(f.spec(), human('m1', '#SLOW 800\n#STEP TEXT first answer'));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'turn.started');
  await new Promise((r) => setTimeout(r, 200));
  // 6,000 characters each: one per Stop, so it takes STOP_CAP + 2 Stops to deliver them all.
  const queued = Array.from({ length: STOP_CAP + 2 }, (_, i) => notice(`s${i}`, 6000));
  const receipts = await settle(Promise.all(queued.map((n) => adapter.queueNotice(h, n))), 60_000);
  assert.deepEqual(receipts.map((r) => r.landed), [...Array(STOP_CAP).fill('stop_hook'), 'new_turn', 'new_turn']);
  const capped = c.of('stop.capped');
  assert.equal(capped.length, 1);
  assert.equal(capped[0]!.pending, 2);
  await c.turns(2, 60_000);
  for (const n of queued) assert.equal(carrying(n.id).length, 1, `${n.id} reached the model exactly once`);
  assert.ok(!c.seen.slice(0, c.seen.findIndex((o) => o.kind === 'stop.capped')).some((o) => o.kind === 'turn.ended'), `the first ${STOP_CAP} kept one turn going`);
  // The count starts again with each turn: the gate works in the next one.
  void adapter.injectMessage(h, human('m2', '#SLOW 800\n#STEP TEXT later answer\n#STEP TEXT after the late notice'));
  await c.until(() => c.of('turn.started').length >= 3);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await settle(adapter.queueNotice(h, notice('late')))).landed, 'stop_hook');
  assert.equal(c.of('stop.capped').length, 1);
  await adapter.stopSession(h, 'graceful');
});
