#!/usr/bin/env node
// The 0B demo (roadmap 0B, the S3 example on the benchmark app): stale-context protection end to end on
// Shelf. agent/frontend reads the API contract; agent/backend changes it; the human lands the backend's
// task with `harness land` (Shelf's own tests run under srt, servers on 127.0.0.1 included, D-83); the
// frontend is synced at its turn end and told "Dependency changed: … has changed since you read it."
// with a diff, then finishes; the human lands it too.
//
//   npm run demo:0b                         scripted model: free, deterministic; everything else is real
//   npm run demo:0b -- --real --provider openrouter
//                                           real agents on a configured provider (D-87), from
//                                           docs/examples/providers.toml; needs that provider's key variable
//   options: --bench <path|url>  the Shelf repo (default: github.com/vihAan02/harness-bench)
//            --providers <file>  where --provider looks;  --keep  keep the temp dir for inspection
//            --budget-usd <d>    with --real, each agent session's budget (default 2)
//
// Needs Postgres (README "Running locally") and network for the clone and Shelf's `npm ci`.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml, stringify as toToml } from 'smol-toml';
import type { Observation } from '../packages/adapters/src/adapter.ts';
import {
  Approvals, computeMetrics, Daemon, harnessHome, parseConfig, renderMetrics, resolveProvider, type ResolvedProvider, type RunningAgent,
} from '../packages/daemon/src/index.ts';
import { createPool, DEFAULT_DATABASE_URL, migrate } from '../packages/server/src/db.ts';
import { startServer } from '../packages/server/src/server.ts';
import { DUMMY_KEY, startMock, type Mock } from '../packages/adapters/test/mock-api.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); const v = i >= 0 ? argv[i + 1] : undefined; return v?.startsWith('--') ? undefined : v; };
const REAL = argv.includes('--real');
const KEEP = argv.includes('--keep');
const BENCH = opt('bench') ?? 'https://github.com/vihAan02/harness-bench.git';
const PROVIDER = opt('provider');
const PROVIDERS_FILE = opt('providers') ?? path.resolve(import.meta.dirname, '../docs/examples/providers.toml');
const BUDGET = Number(opt('budget-usd') ?? '2');
if (!(BUDGET > 0)) throw new Error('--budget-usd must be a positive number of dollars');
if (PROVIDER && !REAL) { console.error('--provider needs --real.'); process.exit(2); }
const agentsConfig: Record<string, unknown> = !REAL ? {} : PROVIDER ? {
  agents: { provider: PROVIDER, max_budget_usd: BUDGET },
  providers: { [PROVIDER]: ((parseToml(fs.readFileSync(PROVIDERS_FILE, 'utf8')) as { providers?: Record<string, unknown> }).providers ?? {})[PROVIDER]
    ?? (() => { console.error(`no [providers.${PROVIDER}] in ${PROVIDERS_FILE}`); process.exit(2); })() },
} : { agents: { max_budget_usd: BUDGET } };

const t0 = Date.now();
const say = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);
const section = (title: string) => console.log(`\n=== ${title} ===`);
const indent = (text: string) => text.split('\n').map((l) => `    ${l}`).join('\n');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-demo0b-')));
const cleanups: (() => Promise<void> | void)[] = [];
let failed = false;

async function main() {
  section(`Harness 0B demo: stale-context protection on Shelf (${REAL ? 'real agents' : 'scripted model; the harness, Claude Code, sandboxes, Git and the server are real'})`);
  const repo = path.join(root, 'shelf');
  execFileSync('git', ['clone', '-q', BENCH, repo]);
  const baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  say(`cloned Shelf at ${baseSha.slice(0, 12)}`);

  const databaseUrl = process.env.HARNESS_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const schema = `demo_${randomBytes(6).toString('hex')}`;
  const admin = createPool(databaseUrl);
  try { await admin.query(`CREATE SCHEMA ${schema}`); } catch (e) { throw new Error(`can't reach Postgres at ${databaseUrl} (${(e as Error).message}). See "Running locally" in README.md.`); }
  cleanups.push(async () => { if (!KEEP) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const pool = createPool(databaseUrl, schema);
  cleanups.push(() => pool.end());
  await migrate(pool);
  await pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_owner', 'You')");
  await pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_laptop', 'human_owner', 'this machine')");
  await pool.query("INSERT INTO projects (id, name, repo_url) VALUES ('prj_shelf', 'Shelf', $1)", [BENCH]);
  await pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ('prj_shelf', 'human_owner', 'owner')");
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ pool, databaseUrl, schema, localToken: token, port: 0 });
  cleanups.push(() => server.close());

  let mock: Mock | null = null;
  if (!REAL) { mock = await startMock(); cleanups.push(() => mock!.close()); }
  const home = harnessHome(path.join(root, 'harness-home'));
  fs.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(home.token, token, { mode: 0o600 });
  const rawConfig = { device_id: 'dev_laptop', principal: 'human_owner', server_url: server.url, limits: { port_range: [3200, 3299] }, ...agentsConfig, projects: [{ id: 'prj_shelf', repo }] };
  fs.writeFileSync(home.config, toToml(rawConfig));
  const config = parseConfig(rawConfig, token);
  let provider: ResolvedProvider | null = null;
  if (REAL) {
    provider = resolveProvider(config, { ...process.env, HARNESS_PROVIDER: PROVIDER ?? '' });
    say(`agents run on ${provider.model?.id ?? "the vendor's default model"}${provider.name ? ` via provider "${provider.name}"` : ''}, capped at $${BUDGET} per session`);
  }
  const observed: { run: RunningAgent; o: Observation }[] = [];
  const daemon = new Daemon({
    home, config, heartbeatMs: 1000, approvalPollMs: 100, finishGraceMs: 30_000, diffIntervalMs: 2000,
    ...(provider ? { provider } : { auth: { mode: 'api-key' as const, apiKey: DUMMY_KEY, baseUrl: mock!.url } }),
    log: (m) => say(`harnessd: ${m}`),
    onObservation: (run, o) => observed.push({ run, o }),
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  await daemon.ready();
  const view = daemon.view('prj_shelf');

  const approvals = new Approvals(home);
  const approver = setInterval(() => {
    for (const r of approvals.pending()) {
      say(`${r.kind === 'test' ? 'test' : 'setup'} command waiting for approval: "${r.command}". You'd run: harness approve ${r.id}. The demo approves it.`);
      approvals.approve(r.id);
    }
  }, 100);
  cleanups.push(() => clearInterval(approver));
  const cli = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve(import.meta.dirname, '../packages/cli/src/main.ts'), ...args], { env: { ...process.env, HARNESS_HOME: home.root } });
    return stdout.trim();
  };
  const until = async (what: string, pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!pred()) {
      // A real agent may stop and ask its human (task_blocked, D-105). This demo has no human to answer, so it
      // stops here with the agent's words, rather than waiting out the deadline.
      const blocked = view.events.find((e) => e.kind === 'message.sent' && (e.data as { kind?: string }).kind === 'task_blocked');
      if (blocked) throw new Error(`an agent reported it's blocked, and the demo has no human to answer it, while waiting for ${what}: ${(blocked.data as { text?: string }).text ?? ''}`);
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const turnEnds = (task: string) => observed.filter((x) => x.run.taskId === task && x.o.kind === 'turn.ended').length;
  const ev = (kind: string, task?: string) => view.events.filter((e) => e.kind === kind && (!task || (e.data as { task_id?: string }).task_id === task));

  // ---------- the scenario ----------
  const T_WEB = 'T-1';
  const T_API = 'T-2';
  const TYPES = 'src/shared/types.ts';
  const wt = (task: string) => daemon.worktreeOf('prj_shelf', task);
  const step = (tool: string, input: unknown) => `#STEP ${tool} ${JSON.stringify(input)}`;
  const edit = (task: string, file: string, oldString: string, newString: string) => {
    if (fs.readFileSync(path.join(repo, file), 'utf8').split(oldString).length !== 2) throw new Error(`Shelf changed: ${file} no longer has the text the demo edits`);
    return [step('Read', { file_path: `${wt(task)}/${file}` }), step('Edit', { file_path: `${wt(task)}/${file}`, old_string: oldString, new_string: newString })];
  };
  section('The scenario');
  console.log([
    '  agent/frontend reads the API contract (src/shared/types.ts), then waits for the login change',
    '  agent/backend  adds expiresAt to the POST /login response and finishes; you land it with `harness land`',
    '  The harness syncs agent/frontend at its turn end and tells it what changed, with a diff; it finishes; you land it too.',
  ].join('\n'));
  await cli('agent', 'add', 'frontend');
  await cli('agent', 'add', 'backend');

  const frontendText = REAL
    ? ['Show when the session expires on the welcome header (renderWelcome in src/client/views.ts).',
      'First read src/shared/types.ts: LoginResponse is the API contract. agent/backend is adding `expiresAt` to it right now, so don\'t change that file yourself, and don\'t start until the harness tells you the change has landed.',
      'Then use login.expiresAt in the header, run `npm test`, and call `report_done`.'].join('\n')
    : ['Show the session expiry on the welcome header. (Scripted for the demo.)',
      step('Read', { file_path: `${wt(T_WEB)}/${TYPES}` }),
      '#STEP TEXT Read the contract; waiting for the login change to land.',
      '#STEP TEXT Noted: agent/backend is changing the contract.',
      step('Read', { file_path: `${wt(T_WEB)}/${TYPES}` }),
      ...edit(T_WEB, 'src/client/views.ts', '<span class="email">${escapeHtml(login.user.email)}</span></header>`;',
        '<span class="email">${escapeHtml(login.user.email)}</span>${login.expiresAt ? ` <span class="expires">until ${escapeHtml(login.expiresAt.slice(11, 16))} UTC</span>` : \'\'}</header>`;'),
      step('Bash', { command: 'npm test 2>&1 | grep -E "^ℹ (pass|fail)"' }),
      step('mcp__harness__report_done', { summary: 'Welcome header shows the session expiry' }),
      '#STEP TEXT Done.'].join('\n');
  const LOGIN_TYPE = '  token: string;\n  user: User;\n};';
  const backendText = REAL
    ? ['Change POST /login so its response also includes `expiresAt`: an ISO 8601 timestamp of when the session expires (sessions last SESSION_HOURS hours, see src/server/auth.ts).',
      'Update LoginResponse in src/shared/types.ts, the route in src/server/routes.ts, and the login check in test/contract/api.contract.test.ts. Run `npm test`, then call `report_done`.'].join('\n')
    : ['Add expiresAt to the POST /login response. (Scripted for the demo.)',
      ...edit(T_API, TYPES, LOGIN_TYPE, '  token: string;\n  user: User;\n  expiresAt: string; // ISO 8601: when the session ends\n};'),
      ...edit(T_API, 'src/server/routes.ts', "import { verifyPassword } from './auth.ts';", "import { SESSION_HOURS, verifyPassword } from './auth.ts';"),
      step('Edit', {
        file_path: `${wt(T_API)}/src/server/routes.ts`,
        old_string: '        const out: LoginResponse = { token: createSession(db, row.id, now()), user: toUser(row) };',
        new_string: '        const at = now();\n        const expiresAt = new Date(at.getTime() + SESSION_HOURS * 3600_000).toISOString();\n        const out: LoginResponse = { token: createSession(db, row.id, at), user: toUser(row), expiresAt };',
      }),
      ...edit(T_API, 'test/contract/api.contract.test.ts', "assertShape(r.body, { token: 'string', user: USER });", "assertShape(r.body, { token: 'string', user: USER, expiresAt: 'string' });"),
      step('mcp__harness__report_done', { summary: 'POST /login returns expiresAt' }),
      '#STEP TEXT Done.'].join('\n');

  console.log(`$ harness task add "Show the session expiry" --scope src/client/ --assign frontend …\n${indent(await cli('task', 'add', 'Show the session expiry', '--scope', 'src/client/', '--assign', 'frontend', '--text', frontendText))}`);
  await until('agent/frontend to read the contract', () => ev('readset.added', T_WEB).some((e) => JSON.stringify(e.data).includes(TYPES)), REAL ? 600_000 : 180_000);
  say('agent/frontend has read src/shared/types.ts');
  if (!REAL) await until('agent/frontend to finish its first turn', () => turnEnds(T_WEB) >= 1, 120_000);
  // The scope covers what the change needs: a unit test builds a LoginResponse, and the README documents the endpoint.
  const API_SCOPE = 'src/server/,src/shared/types.ts,test/contract/,test/unit/,README.md';
  console.log(`$ harness task add "Add expiresAt to the login response" --scope ${API_SCOPE} --assign backend …\n${indent(await cli('task', 'add', 'Add expiresAt to the login response', '--scope', API_SCOPE, '--assign', 'backend', '--text', backendText))}`);
  await until('agent/backend to finish', () => ev('worktree.committed', T_API).length > 0, REAL ? 15 * 60_000 : 180_000);
  say('agent/backend finished; harnessd committed its work');

  section('You land the backend task');
  console.log(`$ harness land ${T_API}\n${indent(await cli('land', T_API))}`);
  await until('agent/frontend to finish', () => ev('worktree.committed', T_WEB).length > 0, REAL ? 15 * 60_000 : 180_000);
  section('You land the frontend task');
  console.log(`$ harness land ${T_WEB}\n${indent(await cli('land', T_WEB))}`);

  // ---------- the 0B exit criterion 1, on Shelf ----------
  section('0B exit criterion 1: the S3 example');
  const checks: [string, boolean, string][] = [];
  const firstRead = ev('readset.added', T_WEB).flatMap((e) => (e.data as { entries: { path: string; hash: string }[] }).entries).find((x) => x.path === TYPES);
  const baseBlob = execFileSync('git', ['-C', repo, 'rev-parse', `${baseSha}:${TYPES}`], { encoding: 'utf8' }).trim();
  checks.push(['A reads src/shared/types.ts at hash ABC', firstRead?.hash === baseBlob, `agent/frontend read ${TYPES} at ${firstRead?.hash?.slice(0, 12) ?? '—'} (the base blob is ${baseBlob.slice(0, 12)})`]);
  const landedApi = ev('land.completed', T_API)[0];
  const tested = view.events.some((e) => e.kind === 'land.progress' && (e.data as { step: string; land_id: string }).step === 'tested');
  checks.push(['B changes it, finishes, and the human lands it (tests green under srt)', !!landedApi && tested,
    landedApi ? `land of ${T_API}: base → ${String((landedApi.data as { new_base_sha: string }).new_base_sha).slice(0, 12)}; Shelf's tests passed in the land's sandbox` : 'not landed']);
  const notice = [...view.messages.values()].find((m) => m.toTask === T_WEB && m.data.stage === 'landed');
  const synced = ev('worktree.synced', T_WEB)[0];
  const delivered = view.events.find((e) => e.kind === 'message.delivered' && (e.data as { message_id: string }).message_id === notice?.id);
  const ordered = !!(landedApi && synced && delivered && landedApi.seq < synced.seq && synced.seq < delivered.seq);
  const sentence = `Dependency changed: ${TYPES} has changed since you read it.`;
  let excerpt = 'diff not checked (real model)';
  let excerptOk = true;
  if (mock && notice) {
    const at = JSON.stringify(mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary).includes(notice.id)).at(-1)?.summary ?? []);
    excerptOk = at.includes(sentence) && at.includes('+  expiresAt: string;');
    excerpt = excerptOk ? 'the injected notice carried the sentence and a diff with "+  expiresAt: string;"' : 'the notice or its diff was missing from what the model saw';
  }
  checks.push(['A is synced at turn end and told, with a diff excerpt', ordered && !!notice?.text.includes(sentence) && excerptOk,
    `${ordered ? 'land.completed → worktree.synced → notice delivered' : 'wrong order or missing'}; ${excerpt}`]);
  const both = ev('land.completed').length === 2;
  checks.push(['Both tasks landed; main has both', both, `main is ${execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'main'], { encoding: 'utf8' }).trim()}: ${execFileSync('git', ['-C', repo, 'log', '--oneline', '-3', 'main'], { encoding: 'utf8' }).trim().replace(/\n/g, ' | ')}`]);
  for (const [what, ok, evidence] of checks) {
    console.log(`${ok ? '✔' : '✖'} ${what}\n    ${evidence}`);
    if (!ok) failed = true;
  }
  section('Metrics (validation.md §4)');
  console.log(indent(renderMetrics(computeMetrics(view))));
  if (KEEP) console.log(`\nKept ${root} and schema ${schema}.`);
  console.log(`\n${failed ? '✖ The S3 example did not complete.' : '✔ The S3 example works end to end on Shelf.'}${REAL ? '' : ' (Scripted model: --real --provider <name> runs real agents.)'}`);
}

let exit = 0;
try {
  await main();
  if (failed) exit = 1;
} catch (e) {
  console.error(`\ndemo failed: ${(e as Error).message}`);
  exit = 1;
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch {} }
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
}
process.exit(exit);
