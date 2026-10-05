// Checks a model provider before any real run (D-104): the key, the endpoint, the pinned model, a tool
// call, and then the same through the pinned Claude Code CLI in a hardened session, as harnessd runs one.
// About $0.01 on the default provider. No Postgres or server needed.
//
//   node scripts/provider-check.ts --provider openrouter        the default real-model provider (D-104)
//   node scripts/provider-check.ts --provider <name> [--providers <file>] [--model <id>] [--http-only]
//
//   --providers <file>  where the [providers.<name>] table is (default docs/examples/providers.toml; your
//                       ~/.harness/config.toml works too)
//   --model <id>        another model on the same provider (its prices aren't known, so cost is a guess)
//   --http-only         skip the Claude Code session
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
import { parseConfig, resolveProvider, type ResolvedProvider } from '../packages/daemon/src/index.ts';
import { readPolicyFor } from '../packages/daemon/src/readpolicy.ts';

export type Line = { ok: boolean; text: string };
/** Test doubles script the model through the prompt (packages/adapters/test/mock-api.ts); real runs pass nothing. */
export type Scripts = { direct?: (code: string) => string; session?: (code: string, worktree: string) => string };

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

/** 2. A hardened Claude Code session with harnessd's policy: the CLI's own request shape, a Read, a harness tool, cost. */
export async function checkSession(p: ResolvedProvider, scripts: Scripts = {}, timeoutMs = 240_000): Promise<Line[]> {
  const out: Line[] = [];
  const redact = redactor(p.auth.apiKey);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-provider-check-')));
  try {
    const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...a], {
      cwd, env: { PATH: process.env.PATH ?? '', HOME: root, GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@h', GIT_COMMITTER_NAME: 'h', GIT_COMMITTER_EMAIL: 'h@h' },
    });
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'wt');
    const word = code();
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'probe.txt'), `The code word is ${word}.\n`);
    git(root, 'init', '-q', '-b', 'main', repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'probe');
    git(repo, 'worktree', 'add', '-q', '-b', 'harness/task/check', worktree);
    const configDir = path.join(root, 'claude-config');
    fs.mkdirSync(configDir, { mode: 0o700 });
    const reported: unknown[] = [];
    const tool: HarnessTool = {
      name: 'report_code', description: 'Report the code word you found.', params: { code: { type: 'string', description: 'The code word', maxLength: 100 } },
      run: async (a) => { reported.push(a.code); return { text: 'Thanks, reported.' }; },
    };
    const gitCommonDir = path.join(repo, '.git');
    const spec: SessionSpec = {
      sessionId: randomUUID(), worktree, gitCommonDir, configDir, ports: null, env: {}, secrets: {},
      auth: p.auth, instructions: '', tools: [tool], ...(p.model ? { model: p.model } : {}), maxBudgetUsd: 0.25,
      readPolicy: readPolicyFor({
        home: os.homedir(), harnessRoot: path.join(root, 'harness'), repo, worktree, gitCommonDir,
        readAllow: [], pathEnv: process.env.PATH ?? '', tmpdir: os.tmpdir(), env: process.env,
      }),
    };
    const adapter = new ClaudeAdapter();
    const seen: Observation[] = [];
    const t0 = Date.now();
    const s = await adapter.startSession(spec, {
      id: 'check-1', origin: 'human',
      text: 'Read the file probe.txt in your working directory with the Read tool, then call the report_code tool with the code word written in it. Then stop. Don\'t edit anything.'
        + (scripts.session ? `\n${scripts.session(word, worktree)}` : ''),
    });
    const reading = (async () => { for await (const o of adapter.observations(s)) seen.push(o); })();
    const deadline = Date.now() + timeoutMs;
    while (!seen.some((o) => o.kind === 'turn.ended' || o.kind === 'ended') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const took = (Date.now() - t0) / 1000;
    await adapter.stopSession(s, 'kill');
    await Promise.race([reading, new Promise((r) => setTimeout(r, 5000))]);
    const of = <K extends Observation['kind']>(k: K) => seen.filter((o): o is Extract<Observation, { kind: K }> => o.kind === k);

    const init = of('session.init')[0];
    if (init && (!p.model || init.model === p.model.id)) out.push({ ok: true, text: `the session started on ${init.model} (Claude Code ${init.vendorVersion})` });
    else out.push({ ok: false, text: init ? `the session reports model ${init.model}, not ${p.model?.id}` : 'the session never started' });
    for (const e of of('error')) out.push({ ok: false, text: `${e.error}: ${redact(e.message).slice(0, 400)}` });
    const turn = of('turn.ended')[0];
    if (!turn) out.push({ ok: false, text: `no turn ended within ${timeoutMs / 1000} s; saw ${[...new Set(seen.map((o) => o.kind))].join(', ') || 'nothing'}` });
    else if (turn.isError) out.push({ ok: false, text: `the turn ended with an error (${turn.reason})` });
    else out.push({ ok: true, text: `one turn in ${took.toFixed(1)} s` });
    if (of('tool.called').some((o) => o.tool === 'Read')) out.push({ ok: true, text: 'the model used the Read tool' });
    else out.push({ ok: false, text: `no Read call; tools called: ${of('tool.called').map((o) => o.tool).join(', ') || 'none'}` });
    if (reported.includes(word)) out.push({ ok: true, text: 'the model called the harness tool with the code word it read' });
    else out.push({ ok: false, text: `the harness tool got ${JSON.stringify(reported)}, not the code word` });
    const usage = of('usage').at(-1);
    if (usage) out.push({ ok: true, text: `cost $${usage.costUsd.toFixed(4)} (${usage.costBasis} prices): ${usage.input} in, ${usage.output} out, ${usage.cacheRead} cache reads, ${usage.cacheCreation} cache writes; models ${usage.models.join(', ')}` });
    return out;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
  console.log(passed
    ? `\n✔ "${name}" works.${args['http-only'] ? '' : ` Next: npm run demo:0b -- --real --provider ${name}`}`
    : '\n✖ The provider check failed. Nothing above includes the key.');
  process.exit(passed ? 0 : 1);
}

if (import.meta.main) await main();
