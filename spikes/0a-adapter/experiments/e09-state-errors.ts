// Q9: what can the adapter reliably expose about session state? API errors, usage,
// query() control methods, and the cost of the default tool surface.
import fs from 'node:fs';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep, Inbox } from '../lib/session.ts';

const f = makeFixture('e09');
const out: any = { errors: [] };
const err = (status: number, type: string, message: string, headers?: Record<string, string>) => ({ status, body: { type: 'error', error: { type, message } }, headers });
const plans: [string, any[], number][] = [
  ['429-then-ok', [err(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit', { 'retry-after': '1' })], 40000],
  ['529-twice-then-ok', [err(529, 'overloaded_error', 'Overloaded'), err(529, 'overloaded_error', 'Overloaded')], 60000],
  ['400-credit', [err(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')], 30000],
  ['401-auth', [err(401, 'authentication_error', 'invalid x-api-key')], 30000],
];
for (const [name, plan, maxMs] of plans) {
  const mock = await startMock();
  mock.failPlan = plan.slice();
  const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-${name}` });
  fs.mkdirSync(o.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const t0 = Date.now();
  const { run, done } = startRun('err test\n#STEP TEXT fine', o);
  const finished = await Promise.race([done.then(() => true), sleep(maxMs).then(() => false)]);
  if (!finished) run.q?.close();
  await mock.close();
  const r: any = run.results.at(-1);
  out.errors.push({ case: name, finished, ms: Date.now() - t0, requests: mock.log.filter((e) => e.kind === 'main').length,
    systemMsgs: run.messages.filter((m: any) => m.type === 'system' && m.subtype !== 'init').map((m: any) => ({ subtype: m.subtype, ...Object.fromEntries(Object.entries(m).filter(([k]) => ['attempt', 'max_retries', 'retry_delay_ms', 'error_status', 'error', 'status'].includes(k))) })),
    rateLimitEvents: run.messages.filter((m: any) => m.type === 'rate_limit_event').length,
    assistantError: run.messages.filter((m: any) => m.type === 'assistant' && m.error).map((m: any) => m.error),
    result: r && { subtype: r.subtype, is_error: r.is_error, result: String(r.result ?? '').slice(0, 200), errors: r.errors, api_error_status: r.api_error_status, terminal_reason: r.terminal_reason },
    sdkError: run.error });
}

// Live-session introspection + usage accounting + tool-surface size.
{
  const mock = await startMock({ rawDir: `${f.root}/raw-live` });
  const inbox = new Inbox();
  inbox.push('live\n#STEP Bash {"command":"echo one"}\n#STEP TEXT live-done', { origin: { kind: 'human' } } as any);
  const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-live`, env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } });
  fs.mkdirSync(o.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const { run, q, done } = startRun(inbox, o);
  while (!run.results.length) await sleep(100);
  const safe = async (fn: () => Promise<any>) => { try { const v = await fn(); return JSON.stringify(v).slice(0, 500); } catch (e: any) { return `ERR ${e.message}`; } };
  out.introspection = {
    initializationResult: await safe(() => q.initializationResult()),
    getContextUsage: await safe(() => q.getContextUsage()),
    mcpServerStatus: await safe(() => q.mcpServerStatus()),
    accountInfo: await safe(() => q.accountInfo()),
    supportedModels: await safe(() => q.supportedModels()),
  };
  inbox.close();
  await Promise.race([done, sleep(5000)]);
  const r: any = run.results.at(-1);
  const mains = mock.log.filter((e) => e.kind === 'main');
  out.usage = {
    mockReturned: mains.map((e) => ({ input: 100 + e.i, output: 10 })),
    resultUsage: { input: r.usage.input_tokens, output: r.usage.output_tokens }, modelUsage: r.modelUsage, total_cost_usd: r.total_cost_usd, num_turns: r.num_turns, duration_ms: r.duration_ms, duration_api_ms: r.duration_api_ms,
  };
  const body = JSON.parse(fs.readFileSync(`${f.root}/raw-live/${String(mains[0].i).padStart(4, '0')}-main.json`, 'utf8'));
  out.surface = { defaultTools: body.tools.length, toolsBytes: JSON.stringify(body.tools).length, systemBytes: JSON.stringify(body.system).length, firstUserBytes: JSON.stringify(body.messages[0]).length };
  out.streamTypes = [...new Set(run.messages.map((m: any) => `${m.type}${m.subtype ? ':' + m.subtype : ''}`))];
  await mock.close();
}
// Same session start with an explicit minimal tool set.
{
  const mock = await startMock({ rawDir: `${f.root}/raw-min` });
  const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-min`, overrides: { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] } });
  fs.mkdirSync(o.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const { run, done } = startRun('min\n#STEP TEXT x', o);
  await done; await mock.close();
  const main = mock.log.find((e) => e.kind === 'main')!;
  const body = JSON.parse(fs.readFileSync(`${f.root}/raw-min/${String(main.i).padStart(4, '0')}-main.json`, 'utf8'));
  out.surfaceMinimal = { initTools: run.init.tools, tools: body.tools.length, toolsBytes: JSON.stringify(body.tools).length, systemBytes: JSON.stringify(body.system).length, firstUserBytes: JSON.stringify(body.messages[0]).length };
}
fs.writeFileSync(`${f.root}/result.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
