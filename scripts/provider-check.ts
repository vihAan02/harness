// Checks a model provider before any real run (D-104): the key, the endpoint, the pinned model, a tool
// call; then the same through the pinned Claude Code CLI in a hardened session, as harnessd runs one; then
// whether the model acts on harness notices delivered through the hooks (D-99, D-100), which OpenRouter
// doesn't guarantee for non-Anthropic models (F-112). About $0.02 on the default provider. No Postgres or
// server needed.
//
//   node scripts/provider-check.ts --provider openrouter        the default real-model provider (D-104)
//   node scripts/provider-check.ts --provider <name> [--providers <file>] [--model <id>] [--http-only]
//
//   --providers <file>  where the [providers.<name>] table is (default docs/examples/providers.toml; your
//                       ~/.harness/config.toml works too)
//   --model <id>        another model on the same provider (its prices aren't known, so cost is a guess)
//   --http-only         skip the Claude Code sessions (stages 2 and 3)
//
// The key comes from the variable the table names (`key_env`), as harnessd reads it (D-87). It's never
// printed: error bodies from the provider are redacted before they're shown.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { ClaudeAdapter, type HarnessTool, type Observation, type SessionSpec } from '../packages/adapters/src/index.ts';
import { parseConfig, renderMessage, resolveProvider, sessionInstructions, type ResolvedProvider } from '../packages/daemon/src/index.ts';
import { readPolicyFor } from '../packages/daemon/src/readpolicy.ts';

export type Line = { ok: boolean; text: string };
/** Test doubles script the model through the prompt (packages/adapters/test/mock-api.ts); real runs pass nothing. */
export type Scripts = { direct?: (code: string) => string; session?: (code: string, worktree: string) => string; notices?: (first: string, second: string) => string };

/** The provider as harnessd would resolve it: the same parser, the same key rules (D-87, D-90). */
export function loadProvider(file: string, name: string, model?: string, env: NodeJS.ProcessEnv = process.env): { p: ResolvedProvider; keyEnv: string } {
  const table = ((parseToml(fs.readFileSync(file, 'utf8')) as { providers?: Record<string, Record<string, unknown>> }).providers ?? {})[name];
  if (!table) throw new Error(`no [providers.${name}] in ${file}`);
  const t = model ? { ...table, model, background_model: model, prices: {} } : table;
  const config = parseConfig({ device_id: 'provider_check', principal: 'provider_check', agents: { provider: name }, providers: { [name]: t } }, 'c'.repeat(32));
  return { p: resolveProvider(config, { ...env, HARNESS_PROVIDER: name }), keyEnv: typeof t.key_env === 'string' ? t.key_env : 'ANTHROPIC_API_KEY' };
}

/** Never show the key, or the tail some providers echo back in a 401 (F-72). */
export function redactor(key: string): (s: string) => string {
  return (s) => s.split(key).join('[key]').split(key.slice(-8)).join('[key]').replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]');
}

const code = () => `harness-${randomBytes(3).toString('hex')}`;

/** 1. The endpoint directly: auth, the model that answered, routing fields accepted, and one tool call. */
export async function checkDirect(p: ResolvedProvider, scripts: Scripts = {}): Promise<Line[]> {
  const out: Line[] = [];
  const redact = redactor(p.auth.apiKey);
  const base = p.auth.baseUrl ?? 'https://api.anthropic.com';
  const model = p.model?.id ?? 'claude-haiku-4-5';
  const word = code();
  // The headers Claude Code sends for this scheme: a bearer provider gets the key in both (D-90).
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': p.auth.apiKey };
  if (p.auth.scheme === 'bearer') headers.authorization = `Bearer ${p.auth.apiKey}`;
  const t0 = Date.now();
  let status: number;
  let body: Record<string, any>;
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST', headers, signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        ...(p.model?.extraBody ?? {}),
        model,
        max_tokens: 4096,
        tools: [{ name: 'report_code', description: 'Report a code word.', input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }],
        messages: [{ role: 'user', content: `Call the report_code tool with code "${word}". Don't reply with text.${scripts.direct ? `\n${scripts.direct(word)}` : ''}` }],
      }),
    });
    status = res.status;
    const text = await res.text();
    try { body = JSON.parse(text) as Record<string, any>; } catch { body = { raw: text.slice(0, 500) }; }
  } catch (e) {
    return [{ ok: false, text: `no answer from ${base}: ${redact((e as Error).message)}` }];
  }
  if (status !== 200) {
    const hint = status === 401 || status === 403 ? ' The key was refused: check it is set in this shell and still active.'
      : status === 402 ? ' Out of credits: top up the account.'
      : status === 404 ? ' No endpoint serves this model with these routing settings (on OpenRouter, the account\'s privacy settings can exclude the pinned provider).'
      : '';
    return [{ ok: false, text: `HTTP ${status}: ${redact(JSON.stringify(body.error ?? body).slice(0, 600))}.${hint}` }];
  }
  out.push({ ok: true, text: `authenticated; HTTP 200 in ${((Date.now() - t0) / 1000).toFixed(1)} s` });
  const served = String(body.model ?? '');
  // Providers may report the model without the router's vendor prefix, or with it.
  if (served === model || served.endsWith(`/${model}`) || model.endsWith(`/${served}`)) out.push({ ok: true, text: `answered by ${served}` });
  else out.push({ ok: false, text: `asked for ${model}, but the response says "${served}": is the endpoint mapping unknown names (F-72)?` });
  const call = (body.content ?? []).find((b: any) => b.type === 'tool_use');
  if (call?.name === 'report_code' && call.input?.code === word) out.push({ ok: true, text: 'the model called the tool with the right argument' });
  else out.push({ ok: false, text: `no correct tool call: ${redact(JSON.stringify(body.content ?? body).slice(0, 400))}` });
  if (body.usage) out.push({ ok: true, text: `usage reported: ${JSON.stringify(body.usage)}` });
  return out;
}

/** One hardened Claude Code session on the provider, as harnessd opens one, in a throwaway repo, with a `report_code` harness tool. */
type Probe = {
  worktree: string; adapter: ClaudeAdapter; handle: Awaited<ReturnType<ClaudeAdapter['startSession']>>;
  seen: Observation[]; reported: unknown[]; t0: number; close: () => Promise<void>;
};
async function openProbe(p: ResolvedProvider, files: Record<string, string>, text: (worktree: string) => string,
  o: { instructions?: string; onObservation?: (obs: Observation, probe: Probe) => void } = {}): Promise<Probe> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-provider-check-')));
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], {
    cwd, env: { PATH: process.env.PATH ?? '', HOME: root, GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@h', GIT_COMMITTER_NAME: 'h', GIT_COMMITTER_EMAIL: 'h@h' },
  });
  const repo = path.join(root, 'repo');
  const worktree = path.join(root, 'wt');
  fs.mkdirSync(repo);
  for (const [name, content] of Object.entries({ 'README.md': 'probe\n', ...files })) fs.writeFileSync(path.join(repo, name), content);
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'probe');
  git(repo, 'worktree', 'add', '-q', '-b', 'harness/task/check', worktree);
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(configDir, { mode: 0o700 });
  const reported: unknown[] = [];
  const tool: HarnessTool = {
    name: 'report_code', description: 'Report a code word.', params: { code: { type: 'string', description: 'The code word', maxLength: 100 } },
    run: async (a) => { reported.push(a.code); return { text: 'Thanks, reported.' }; },
  };
  const gitCommonDir = path.join(repo, '.git');
  const spec: SessionSpec = {
    sessionId: randomUUID(), worktree, gitCommonDir, configDir, ports: null, env: {}, secrets: {},
    auth: p.auth, instructions: o.instructions ?? '', tools: [tool], ...(p.model ? { model: p.model } : {}), maxBudgetUsd: 0.25,
    readPolicy: readPolicyFor({
      home: os.homedir(), harnessRoot: path.join(root, 'harness'), repo, worktree, gitCommonDir,
      readAllow: [], pathEnv: process.env.PATH ?? '', tmpdir: os.tmpdir(), env: process.env,
    }),
  };
  const adapter = new ClaudeAdapter();
  const seen: Observation[] = [];
  const t0 = Date.now();
  const handle = await adapter.startSession(spec, { id: 'check-1', origin: 'human', text: text(worktree) });
  const probe: Probe = {
    worktree, adapter, handle, seen, reported, t0,
    close: async () => {
      await adapter.stopSession(handle, 'kill');
      await Promise.race([reading, new Promise((r) => setTimeout(r, 5000))]);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  const reading = (async () => { for await (const obs of adapter.observations(handle)) { seen.push(obs); o.onObservation?.(obs, probe); } })();
  return probe;
}

const until = async (pred: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  return pred();
};
const of = <K extends Observation['kind']>(seen: Observation[], k: K) => seen.filter((o): o is Extract<Observation, { kind: K }> => o.kind === k);

/** What every probe reports: the model it started on, errors, and its cost. */
function sessionLines(p: ResolvedProvider, probe: Probe): Line[] {
  const out: Line[] = [];
  const redact = redactor(p.auth.apiKey);
  const init = of(probe.seen, 'session.init')[0];
  if (init && (!p.model || init.model === p.model.id)) out.push({ ok: true, text: `the session started on ${init.model} (Claude Code ${init.vendorVersion})` });
  else out.push({ ok: false, text: init ? `the session reports model ${init.model}, not ${p.model?.id}` : 'the session never started' });
  for (const e of of(probe.seen, 'error')) out.push({ ok: false, text: `${e.error}: ${redact(e.message).slice(0, 400)}` });
  return out;
}
function costLine(probe: Probe): Line[] {
  const usage = of(probe.seen, 'usage').at(-1);
  return usage ? [{ ok: true, text: `cost $${usage.costUsd.toFixed(4)} (${usage.costBasis} prices): ${usage.input} in, ${usage.output} out, ${usage.cacheRead} cache reads, ${usage.cacheCreation} cache writes; models ${usage.models.join(', ')}` }] : [];
}

/** 2. A hardened Claude Code session with harnessd's policy: the CLI's own request shape, a Read, a harness tool, cost. */
export async function checkSession(p: ResolvedProvider, scripts: Scripts = {}, timeoutMs = 240_000): Promise<Line[]> {
  const word = code();
  const probe = await openProbe(p, { 'probe.txt': `The code word is ${word}.\n` }, (worktree) =>
    'Read the file probe.txt in your working directory with the Read tool, then call the report_code tool with the code word written in it. Then stop. Don\'t edit anything.'
      + (scripts.session ? `\n${scripts.session(word, worktree)}` : ''));
  try {
    await until(() => probe.seen.some((o) => o.kind === 'turn.ended' || o.kind === 'ended'), timeoutMs);
    const took = (Date.now() - probe.t0) / 1000;
    const out = sessionLines(p, probe);
    const turn = of(probe.seen, 'turn.ended')[0];
    if (!turn) out.push({ ok: false, text: `no turn ended within ${timeoutMs / 1000} s; saw ${[...new Set(probe.seen.map((o) => o.kind))].join(', ') || 'nothing'}` });
    else if (turn.isError) out.push({ ok: false, text: `the turn ended with an error (${turn.reason})` });
    else out.push({ ok: true, text: `one turn in ${took.toFixed(1)} s` });
    if (of(probe.seen, 'tool.called').some((o) => o.tool === 'Read')) out.push({ ok: true, text: 'the model used the Read tool' });
    else out.push({ ok: false, text: `no Read call; tools called: ${of(probe.seen, 'tool.called').map((o) => o.tool).join(', ') || 'none'}` });
    if (probe.reported.includes(word)) out.push({ ok: true, text: 'the model called the harness tool with the code word it read' });
    else out.push({ ok: false, text: `the harness tool got ${JSON.stringify(probe.reported)}, not the code word` });
    return [...out, ...costLine(probe)];
  } finally {
    await probe.close();
  }
}

/**
 * 3. Harness notices through the hooks (D-99, D-100), the part OpenRouter doesn't guarantee for other models
 * (F-112). The first notice rides the result of the agent's Bash call; the second is queued after its last tool
 * call, while the agent writes a longer final reply, so it reaches the model at the Stop gate (or, if the turn
 * has already ended, as a new turn). The model shows it read each one by reporting the notice's code word.
 * Where each landed is reported too.
 */
export async function checkNotices(p: ResolvedProvider, scripts: Scripts = {}, timeoutMs = 240_000, secondAfterMs = 700): Promise<Line[]> {
  const [w1, w2] = [code(), code()];
  const notice = (id: string, path_: string, word: string) => ({
    id, origin: 'coordinator' as const,
    text: renderMessage({ id, kind: 'dependency_changed', fromTask: null, sender: { kind: 'harness' }, text: `Dependency changed: ${path_} has changed since you read it. This notice's code word is ${word}.` }),
  });
  const landed: Record<string, string> = {};
  let queued = 0;
  const probe = await openProbe(p, {}, () =>
    'Run the command `sleep 4; echo built` with the Bash tool, once. While you work, harness notices may arrive; if one gives you a code word, call report_code with that word. '
      + 'When you\'re done, finish with a summary of about 150 words of what you did and what the notices said.'
      + (scripts.notices ? `\n${scripts.notices(w1, w2)}` : ''), {
    instructions: sessionInstructions({ agentName: 'agent/check', taskId: 'T-1', ports: null, repo: [] }),
    onObservation: (obs, pr) => {
      if (obs.kind === 'delivery') landed[obs.messageId] = obs.landed;
      // The first notice as soon as the Bash call starts: it rides that call's result.
      if (obs.kind === 'tool.called' && obs.tool === 'Bash' && queued === 0) {
        queued = 1;
        void pr.adapter.queueNotice(pr.handle, notice('n1', 'src/app.ts', w1)).then((r) => { landed.n1 = r.landed; }, () => {});
      }
      // The second once the first is reported, a moment after that call: after the agent's last tool batch.
      if (obs.kind === 'tool.result' && queued === 1 && pr.reported.includes(w1)) {
        queued = 2;
        setTimeout(() => void pr.adapter.queueNotice(pr.handle, notice('n2', 'src/types.ts', w2)).then((r) => { landed.n2 = r.landed; }, () => {}), secondAfterMs);
      }
    },
  });
  try {
    await until(() => probe.reported.includes(w1) && probe.reported.includes(w2), timeoutMs);
    const out = sessionLines(p, probe);
    const where = (id: string) => (landed[id] ? `, delivered ${landed[id]!.replace('_', ' ')}` : '');
    if (probe.reported.includes(w1)) out.push({ ok: true, text: `the model acted on a notice riding its tool result${where('n1')}` });
    else out.push({ ok: false, text: `no report of the first notice's code word${where('n1')}; reported ${JSON.stringify(probe.reported)}` });
    if (probe.reported.includes(w2)) out.push({ ok: true, text: `the model acted on a notice that came after its last tool call${where('n2')}` });
    else out.push({ ok: false, text: `no report of the second notice's code word${where('n2')}; reported ${JSON.stringify(probe.reported)}` });
    return [...out, ...costLine(probe)];
  } finally {
    await probe.close();
  }
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: { provider: { type: 'string' }, providers: { type: 'string' }, model: { type: 'string' }, 'http-only': { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (args.help || !args.provider) {
    console.log('usage: node scripts/provider-check.ts --provider <name> [--providers <file>] [--model <id>] [--http-only]');
    process.exit(args.help ? 0 : 2);
  }
  const name = args.provider;
  const file = args.providers ?? path.resolve(import.meta.dirname, '../docs/examples/providers.toml');
  let loaded: ReturnType<typeof loadProvider>;
  try {
    loaded = loadProvider(file, name, args.model);
  } catch (e) {
    console.error(`provider-check: ${(e as Error).message}`);
    process.exit(2);
  }
  const { p, keyEnv } = loaded;
  console.log(`Provider "${name}" from ${file}`);
  console.log(`  endpoint ${p.auth.baseUrl ?? 'https://api.anthropic.com'}, auth ${p.auth.scheme ?? 'x-api-key'}, key from ${keyEnv} (${p.auth.apiKey.length} characters, not shown)`);
  console.log(`  model ${p.model?.id ?? "the vendor's default"}${p.model?.extraBody ? `, extra body ${JSON.stringify(p.model.extraBody)}` : ''}`);
  const show = (lines: Line[]) => { for (const l of lines) console.log(`  ${l.ok ? '✔' : '✖'} ${l.text}`); return lines.every((l) => l.ok); };
  console.log('\n1. The Messages API directly');
  let passed = show(await checkDirect(p));
  if (passed && !args['http-only']) {
    console.log("\n2. A hardened Claude Code session (the pinned CLI, harnessd's policy, a Read and a harness tool)");
    passed = show(await checkSession(p));
  }
  if (passed && !args['http-only']) {
    console.log('\n3. Harness notices through the hooks: on a tool result, and after the last tool call (D-99, D-100)');
    passed = show(await checkNotices(p));
  }
  console.log(passed
    ? `\n✔ "${name}" works.${args['http-only'] ? '' : ` Next: npm run demo:0b -- --real --provider ${name}`}`
    : '\n✖ The provider check failed. Nothing above includes the key.');
  process.exit(passed ? 0 : 1);
}

if (import.meta.main) await main();
