// ClaudeAdapter against third-party Anthropic-compatible endpoints (D-87), with the real pinned CLI and
// the scripted mock in its provider modes. No key and no network: these check what the CLI sends where,
// and that the hardening holds for every auth scheme. Each security rule has a negative control.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAdapter, type ClaudeSession } from '../src/index.ts';
import type { SessionSpec } from '../src/adapter.ts';
import { collect, fixture, script, type Fixture } from './fixtures.ts';
import { DUMMY_KEY, startMock, type Mock, type MockOptions } from './mock-api.ts';

const live: ClaudeSession[] = [];
const mocks: Mock[] = [];
class Tracked extends ClaudeAdapter {
  override open(...args: Parameters<ClaudeAdapter['open']>) {
    const s = super.open(...args);
    live.push(s);
    return s;
  }
}
const adapter = new Tracked();
let f: Fixture;
before(async () => { f = await fixture(); });
after(async () => {
  await Promise.all(live.map((s) => s.stop('kill')));
  await Promise.all(mocks.map((m) => m.close()));
  await f.cleanup();
});

const human = (id: string, text: string) => ({ id, origin: 'human' as const, text });
async function provider(opts: MockOptions): Promise<Mock> {
  const m = await startMock(opts);
  mocks.push(m);
  return m;
}
const messages = (m: Mock) => m.log.filter((e) => e.path.includes('/v1/messages'));
const toolResults = (m: Mock) => m.log.flatMap((e) => (e.summary ?? []).flatMap((x: any) => x.blocks.filter((b: any) => b.type === 'tool_result').map((b: any) => b.text as string)));
const PRICES = { 'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 } };
const deepseekLike = (m: Mock, over: Partial<NonNullable<SessionSpec['model']>> = {}): Partial<SessionSpec> => ({
  auth: { mode: 'api-key', apiKey: DUMMY_KEY, scheme: 'x-api-key', baseUrl: `${m.url}/anthropic` },
  model: { id: 'deepseek-flash', background: 'deepseek-flash', stripExperimental: true, prices: PRICES, extraBody: { provider: { allow_fallbacks: false } }, ...over },
});

test('an x-api-key provider under a base path: right path, header, model and fields; cost from configured prices (D-87)', async () => {
  const m = await provider({ basePath: '/anthropic', auth: 'x-api-key', strict: true, models: ['deepseek-flash'] });
  const h = await adapter.startSession(f.spec(deepseekLike(m)), human('m1', script('Bash {"command":"echo hi"}', 'TEXT done')));
  const c = collect(adapter.observations(h));
  await c.turns(1);
  assert.equal(c.of('turn.ended')[0]!.isError, false, JSON.stringify(c.of('error')));
  assert.equal(c.of('session.init')[0]!.model, 'deepseek-flash', 'the hardening check accepted the configured model');
  const sent = messages(m);
  assert.ok(sent.length >= 2);
  for (const e of sent) {
    assert.ok(e.path.startsWith('/anthropic/v1/messages'), e.path);
    assert.equal(e.model, 'deepseek-flash', 'every request, main or background, uses the pinned model (F-25)');
    assert.ok(e.authOk && !e.bearerPresent, 'the key went as x-api-key only');
    assert.equal(e.rejected, undefined, `the strict endpoint accepted it: ${e.rejected}`);
    assert.ok(!e.bodyKeys.includes('context_management'), 'experimental fields stripped (F-26)');
    assert.ok(e.bodyKeys.includes('provider'), 'extra_body merged into the request (F-29)');
  }
  const usage = c.of('usage').at(-1)!;
  assert.equal(usage.costBasis, 'config');
  assert.deepEqual(usage.models, ['deepseek-flash']);
  const expected = (usage.input * 0.3 + usage.output * 1.2 + usage.cacheRead * 0.006 + usage.cacheCreation * 0.3) / 1e6;
  assert.ok(Math.abs(usage.costUsd - expected) < 1e-6, `${usage.costUsd} vs ${expected}`);
  await adapter.stopSession(h, 'kill');
});

test('negative control: without stripping, a strict provider rejects the request', async () => {
  const m = await provider({ basePath: '/anthropic', auth: 'x-api-key', strict: true });
  const h = await adapter.startSession(f.spec(deepseekLike(m, { stripExperimental: false })), human('m1', script('TEXT never')));
  const c = collect(adapter.observations(h));
  await c.turns(1, 60_000);
  assert.ok(messages(m).some((e) => e.rejected?.includes('context_management')), JSON.stringify(messages(m).map((e) => e.rejected)));
  assert.equal(c.of('turn.ended')[0]!.isError, true);
  await adapter.stopSession(h, 'kill');
});

test('a bearer provider: the key goes as a bearer token, the auth-source check holds, and the shell sees neither variable (D-64, D-87)', async () => {
  const m = await provider({ auth: 'bearer' });
  const h = await adapter.startSession(f.spec({ auth: { mode: 'api-key', apiKey: DUMMY_KEY, scheme: 'bearer', baseUrl: m.url }, model: { id: 'kimi-k2.6' } }), human('m1', script(
    'Bash {"command":"echo STARTED; env | grep -c -E \'ANTHROPIC_(API_KEY|AUTH_TOKEN)\'; echo ${ANTHROPIC_API_KEY:-unset} ${ANTHROPIC_AUTH_TOKEN:-unset}"}',
    'TEXT done',
  )));
  const c = collect(adapter.observations(h));
  await c.turns(1);
  assert.equal(c.of('error').length, 0, JSON.stringify(c.of('error')));
  assert.ok(messages(m).every((e) => e.bearerOk && !e.rejected), 'every request carried the bearer token');
  const probe = toolResults(m).at(-1)!;
  assert.match(probe, /STARTED/);
  assert.ok(!probe.includes(DUMMY_KEY), 'neither auth variable reached the shell');
  assert.match(probe, /unset unset/);
  await adapter.stopSession(h, 'kill');
});

test('negative control: an auth variable left off the deny list reaches the shell', async () => {
  const m = await provider({ auth: 'bearer' });
  const leaky = new (class extends Tracked {
    override compilePermissions(spec: SessionSpec) {
      const p = super.compilePermissions(spec);
      const sb = p.sandbox as Record<string, any>;
      return { ...p, sandbox: { ...sb, credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' as const }] } } };
    }
  })();
  const h = await leaky.startSession(f.spec({ auth: { mode: 'api-key', apiKey: DUMMY_KEY, scheme: 'bearer', baseUrl: m.url } }), human('m1', script(
    'Bash {"command":"echo STARTED ${ANTHROPIC_AUTH_TOKEN:-unset}"}', 'TEXT done',
  )));
  const c = collect(leaky.observations(h));
  await c.turns(1);
  assert.ok(toolResults(m).at(-1)!.includes(DUMMY_KEY), 'without the deny rule the token is readable, so the rule is load-bearing');
  await leaky.stopSession(h, 'kill');
});

test('a session that costs more than its budget is stopped (D-87)', async () => {
  const m = await provider({});
  const spec = f.spec({ auth: { mode: 'api-key', apiKey: DUMMY_KEY, baseUrl: m.url }, model: { id: 'deepseek-flash', prices: { 'deepseek-flash': { input: 1000, output: 1000 } } }, maxBudgetUsd: 0.01 });
  const h = await adapter.startSession(spec, human('m1', script('TEXT done')));
  const c = collect(adapter.observations(h));
  await c.done;
  assert.ok(c.of('error').some((e) => e.error === 'budget'), JSON.stringify(c.of('error')));
  assert.equal(c.of('ended')[0]!.reason, 'budget exceeded');
});

test('a secret named like a CLI setting is refused; without the check, it sends the key elsewhere (D-87, TH-21)', async () => {
  const attacker = await provider({});
  await assert.rejects(adapter.startSession(f.spec({ secrets: { ANTHROPIC_BASE_URL: attacker.url }, auth: { mode: 'api-key', apiKey: DUMMY_KEY } }), human('m1', 'x')), /may not set ANTHROPIC_BASE_URL/);
  await assert.rejects(adapter.startSession(f.spec({ model: { id: '--dangerously-skip-permissions' } }), human('m1', 'x')), /malformed/);
  assert.equal(attacker.log.length, 0);

  // Negative control: skip the check, and the vendor-default session's key goes to the secret's host.
  const unchecked = new (class extends Tracked { override checkInputs() {} })();
  const h = await unchecked.startSession(f.spec({ secrets: { ANTHROPIC_BASE_URL: attacker.url }, auth: { mode: 'api-key', apiKey: DUMMY_KEY } }), human('m1', script('TEXT done')));
  const c = collect(unchecked.observations(h));
  await c.turns(1);
  assert.ok(messages(attacker).some((e) => e.authOk), 'the key reached the host the secret named');
  await unchecked.stopSession(h, 'kill');
});
