// scripts/provider-check.ts, the check run before any real-model run (D-104), with no key and no network:
// a stand-in for the direct call, and the real pinned CLI against the scripted mock for the session. Each
// rule it checks has a negative control.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResolvedProvider } from '../packages/daemon/src/index.ts';
import { DUMMY_KEY, startMock, type Mock } from '../packages/adapters/test/mock-api.ts';
import { checkDirect, checkSession, loadProvider, redactor } from '../scripts/provider-check.ts';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const ROUTING = { provider: { only: ['deepseek'], allow_fallbacks: false } };
const provider = (baseUrl: string, over: Partial<NonNullable<ResolvedProvider['model']>> = {}, key = DUMMY_KEY): ResolvedProvider => ({
  name: 'openrouter',
  auth: { mode: 'api-key', apiKey: key, scheme: 'bearer', baseUrl },
  model: { id: MODEL, background: MODEL, stripExperimental: true, extraBody: ROUTING, prices: { [MODEL]: { input: 0.3, output: 1.2, cacheRead: 0.006 } }, ...over },
});

const servers: { close: () => unknown }[] = [];
after(async () => { for (const s of servers) await s.close(); });

/** A Messages endpoint that answers with the tool call the prompt asks for, and records what it got. */
async function standIn(opts: { answerModel?: (asked: string) => string; echoKeyTail?: boolean } = {}) {
  const got: { headers: http.IncomingHttpHeaders; body: any }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      got.push({ headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${DUMMY_KEY}`) {
        // Like a provider that echoes the key's tail in a 401 (F-72).
        const tail = String(req.headers.authorization ?? '').slice(-10);
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'authentication_error', message: `invalid key ...${opts.echoKeyTail ? tail : ''}` } }));
        return;
      }
      const word = /code "([^"]+)"/.exec(String(body.messages?.[0]?.content))?.[1];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: opts.answerModel?.(body.model) ?? body.model, stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'report_code', input: { code: word } }], usage: { input_tokens: 20, output_tokens: 5 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push({ close: () => new Promise((r) => server.close(r)) });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, got };
}

test('the direct check: bearer and x-api-key both carry the key, the routing pin is in the body, the tool call comes back', async () => {
  const s = await standIn();
  const lines = await checkDirect(provider(s.url));
  assert.ok(lines.every((l) => l.ok), JSON.stringify(lines));
  const { headers, body } = s.got[0]!;
  assert.equal(headers['x-api-key'], DUMMY_KEY, 'the key also goes as x-api-key, as Claude Code sends it for a bearer provider (D-90)');
  assert.equal(body.model, MODEL);
  assert.deepEqual(body.provider, ROUTING.provider, 'extra_body pins the provider on the probe too');
});

test('negative controls: another model answering, and a refused key, both fail; the key never shows', async () => {
  const swapped = await standIn({ answerModel: () => 'deepseek-flash-quantized' });
  const l1 = await checkDirect(provider(swapped.url));
  assert.ok(l1.some((l) => !l.ok && /asked for deepseek\/deepseek-v4.1-flash/.test(l.text)), JSON.stringify(l1));

  const echo = await standIn({ echoKeyTail: true });
  const wrong = 'sk-or-v1-wrong-key-0123456789abcdef';
  const l2 = await checkDirect(provider(echo.url, {}, wrong));
  assert.ok(l2.some((l) => !l.ok && /HTTP 401/.test(l.text) && /key was refused/.test(l.text)), JSON.stringify(l2));
  const text = JSON.stringify(l2);
  assert.ok(!text.includes(wrong) && !text.includes(wrong.slice(-8)), `the key or its tail leaked: ${text}`);
});

test('redaction covers the key, its tail and key-shaped tokens', () => {
  const r = redactor('sk-or-v1-abcdef0123456789');
  assert.equal(r('a sk-or-v1-abcdef0123456789 b ...23456789 c sk-other-zzzzzzzz'), 'a [key] b ...[key] c sk-[redacted]');
});

let mock: Mock;
after(async () => { await mock?.close(); });

test('the session check: the pinned CLI on the provider settings, a Read, the harness tool, configured prices (D-90, D-104)', async () => {
  mock = await startMock({ auth: 'bearer', strict: true, models: [MODEL] });
  const lines = await checkSession(provider(mock.url), {
    session: (_code, worktree) => [
      `#STEP Read {"file_path":"${worktree}/probe.txt"}`,
      '#STEP mcp__harness__report_code {"code":"{{find:code word is (harness-[0-9a-f]+)}}"}',
      '#STEP TEXT done',
    ].join('\n'),
  }, 120_000);
  assert.ok(lines.every((l) => l.ok), JSON.stringify(lines, null, 1));
  assert.ok(lines.some((l) => /config prices/.test(l.text)), 'cost comes from the configured prices');
  const sent = mock.log.filter((e) => e.path.includes('/v1/messages') && !e.path.includes('count_tokens'));
  assert.ok(sent.length >= 2 && sent.every((e) => e.model === MODEL && e.bearerOk && !e.rejected && e.bodyKeys.includes('provider')), JSON.stringify(sent.map((e) => [e.model, e.rejected])));
});

test('negative control: a model the endpoint doesn\'t serve fails the session check', async () => {
  const m = await startMock({ auth: 'bearer', models: [MODEL] });
  try {
    const lines = await checkSession(provider(m.url, { id: 'deepseek/other', background: 'deepseek/other', prices: { 'deepseek/other': { input: 0.3, output: 1.2 } } }), {
      session: () => '#STEP TEXT never',
    }, 60_000);
    assert.ok(lines.some((l) => !l.ok), JSON.stringify(lines));
  } finally {
    await m.close();
  }
});

test('the example file\'s openrouter table loads as harnessd resolves it, with the key from OPENROUTER_API_KEY', () => {
  const file = new URL('../docs/examples/providers.toml', import.meta.url).pathname;
  const { p, keyEnv } = loadProvider(file, 'openrouter', undefined, { OPENROUTER_API_KEY: 'sk-or-v1-0123456789' });
  assert.equal(keyEnv, 'OPENROUTER_API_KEY');
  assert.equal(p.model!.id, MODEL);
  assert.throws(() => loadProvider(file, 'openrouter', undefined, {}), /set OPENROUTER_API_KEY in harnessd's environment for the "openrouter" provider/);
  const other = loadProvider(file, 'openrouter', 'qwen/qwen3-coder-next', { OPENROUTER_API_KEY: 'sk-or-v1-0123456789' });
  assert.equal(other.p.model!.id, 'qwen/qwen3-coder-next');
  assert.equal(other.p.model!.prices, undefined, '--model drops the table\'s prices: the cost basis says it\'s a guess');
});
