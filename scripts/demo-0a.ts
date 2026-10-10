#!/usr/bin/env node
// The 0A demo (roadmap 0A item 11): the whole stack on one machine, two Claude Code agents on the
// benchmark app (Shelf), and a check of every 0A exit criterion (S3).
//
//   npm run demo                 scripted model: free, deterministic; everything else is real
//   npm run demo -- --real       real agents: needs ANTHROPIC_API_KEY (D-56); costs a little
//   npm run demo -- --real --provider openrouter
//                                real agents on a configured provider (D-87, D-104), from docs/examples/providers.toml;
//                                needs that provider's key variable (OPENROUTER_API_KEY for openrouter)
//   options: --bench <path|url>  the Shelf repo (default: github.com/vihAan02/harness-bench)
//            --model <id>        with --real and no provider, the model for both agents
//            --providers <file>  where --provider looks (default docs/examples/providers.toml)
//            --keep              keep the temp dir (repo, worktrees, ~/.harness) for inspection
//            --budget-usd <d>    with --real, each agent session's budget (default 2)
//
// Needs Postgres (see README "Running locally"). It uses a throwaway schema in HARNESS_DATABASE_URL
// (default harness_dev) and drops it at the end.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml, stringify as toToml } from 'smol-toml';
import type { Observation } from '../packages/adapters/src/adapter.ts';
import {
  Approvals, computeMetrics, Daemon, duration, harnessHome, parseConfig, renderAgentStatus, renderHumanStatus, renderMetrics, resolveProvider,
  type ResolvedProvider, type RunningAgent,
} from '../packages/daemon/src/index.ts';
import type { EventMessage } from '../packages/protocol/src/index.ts';
import { createPool, DEFAULT_DATABASE_URL, migrate } from '../packages/server/src/db.ts';
import { startServer } from '../packages/server/src/server.ts';
import { DUMMY_KEY, startMock, type Mock } from '../packages/adapters/test/mock-api.ts';

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); const v = i >= 0 ? argv[i + 1] : undefined; return v?.startsWith('--') ? undefined : v; };
const REAL = argv.includes('--real');
const KEEP = argv.includes('--keep');
const BENCH = opt('bench') ?? 'https://github.com/vihAan02/harness-bench.git';
const MODEL = opt('model');
const PROVIDER = opt('provider');
const BUDGET = Number(opt('budget-usd') ?? '2');
if (!(BUDGET > 0)) throw new Error('--budget-usd must be a positive number of dollars');
const PROVIDERS_FILE = opt('providers') ?? path.resolve(import.meta.dirname, '../docs/examples/providers.toml');
if (PROVIDER && !REAL) {
  console.error('--provider needs --real: the scripted model never calls a provider.');
  process.exit(2);
}
if (PROVIDER && MODEL) {
  console.error('--model is for the vendor default endpoint; with --provider, the model comes from the provider table.');
  process.exit(2);
}
/** The [agents] and [providers] part of the demo's config.toml (D-87). */
const agentsConfig: Record<string, unknown> = !REAL ? {}
  : PROVIDER ? {
    agents: { provider: PROVIDER, max_budget_usd: BUDGET },
    providers: { [PROVIDER]: ((parseToml(fs.readFileSync(PROVIDERS_FILE, 'utf8')) as { providers?: Record<string, unknown> }).providers ?? {})[PROVIDER] ?? (() => {
      console.error(`no [providers.${PROVIDER}] in ${PROVIDERS_FILE}`);
      process.exit(2);
    })() },
  }
  : { agents: { ...(MODEL ? { model: MODEL } : {}), max_budget_usd: BUDGET } };

const t0 = Date.now();
const say = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);
const section = (title: string) => console.log(`\n=== ${title} ===`);
const indent = (text: string) => text.split('\n').map((l) => `    ${l}`).join('\n');

// ---------- the stack ----------
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-demo-')));
const cleanups: (() => Promise<void> | void)[] = [];
let failed = false;

async function main() {
  section(`Harness 0A demo (${REAL ? 'real agents' : 'scripted model: the harness, Claude Code, sandboxes, Git and the server are real'})`);

  // Shelf, the benchmark app (D-83).
  const repo = path.join(root, 'shelf');
  execFileSync('git', ['clone', '-q', BENCH, repo]);
  const baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  say(`cloned Shelf from ${BENCH} at ${baseSha.slice(0, 12)}`);

  // The coordination server, on a throwaway schema.
  const databaseUrl = process.env.HARNESS_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const schema = `demo_${randomBytes(6).toString('hex')}`;
  const admin = createPool(databaseUrl);
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (e) {
    throw new Error(`can't reach Postgres at ${databaseUrl} (${(e as Error).message}). See "Running locally" in README.md.`);
  }
  cleanups.push(async () => { if (!KEEP) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const pool = createPool(databaseUrl, schema);
  cleanups.push(() => pool.end());
  await migrate(pool);
  // There's no sign-up in 0A: the demo registers you, this machine and the project directly.
  await pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_owner', 'You')");
  await pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_laptop', 'human_owner', 'this machine')");
  await pool.query("INSERT INTO projects (id, name, repo_url) VALUES ('prj_shelf', 'Shelf', $1)", [BENCH]);
  await pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ('prj_shelf', 'human_owner', 'owner')");
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ pool, databaseUrl, schema, localToken: token, port: 0 });
  cleanups.push(() => server.close());
  say(`coordination server on ${server.url} (schema ${schema})`);

  // The model: a scripted stand-in, or the real API.
  let mock: Mock | null = null;
  if (!REAL) {
    mock = await startMock();
    cleanups.push(() => mock!.close());
  }

  // harnessd, with its own ~/.harness.
  const home = harnessHome(path.join(root, 'harness-home'));
  fs.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(home.token, token, { mode: 0o600 });
  const rawConfig = {
    device_id: 'dev_laptop', principal: 'human_owner', server_url: server.url, limits: { port_range: [3100, 3199] },
    ...agentsConfig,
    projects: [{ id: 'prj_shelf', repo }],
  };
  fs.writeFileSync(home.config, toToml(rawConfig));
  const config = parseConfig(rawConfig, token);
  // Real runs: the endpoint, model and key come from the config and the environment, as harnessd's own
  // startup reads them (D-87). The key is never printed.
  let provider: ResolvedProvider | null = null;
  if (REAL) {
    try {
      provider = resolveProvider(config, { ...process.env, HARNESS_PROVIDER: PROVIDER ?? '' }); // the flag decides, not the shell
    } catch (e) {
      throw new Error(`--real: ${(e as Error).message}`);
    }
    say(`agents run on ${provider.model?.id ?? "the vendor's default model"}${provider.name ? ` via provider "${provider.name}"` : ''}, capped at $2 per session`);
  }
  const observed: { run: RunningAgent; o: Observation }[] = [];
  let onEvent: (e: EventMessage) => void = () => {};
  const daemon = new Daemon({
    home, config, heartbeatMs: 1000, approvalPollMs: 100, finishGraceMs: 30_000, diffIntervalMs: 2000,
    ...(provider ? { provider } : { auth: { mode: 'api-key' as const, apiKey: DUMMY_KEY, baseUrl: mock!.url } }),
    log: (m) => say(`harnessd: ${m}`),
    onObservation: (run, o) => observed.push({ run, o }),
    onEvent: (e) => onEvent(e), // after the event is folded into harnessd's view
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  await daemon.ready();
  say('harnessd connected');
  const view = daemon.view('prj_shelf');

  // Shelf's harness.yaml setup command needs your approval (D-52). The demo approves it for you.
  const approvals = new Approvals(home);
  const approver = setInterval(() => {
    for (const r of approvals.pending()) {
      say(`setup command waiting for approval: "${r.command}". You'd run: harness approve ${r.id}. The demo approves it.`);
      approvals.approve(r.id);
    }
  }, 100);
  cleanups.push(() => clearInterval(approver));

  const cli = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [path.resolve(import.meta.dirname, '../packages/cli/src/main.ts'), ...args],
      { env: { ...process.env, HARNESS_HOME: home.root } });
    return stdout.trim();
  };
  const until = async (what: string, pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const turnEnds = (task: string) => observed.filter((x) => x.run.taskId === task && x.o.kind === 'turn.ended').length;
  const events = (kind: string) => view.events.filter((e) => e.kind === kind);

  // ---------- the scenario ----------
  section('The scenario');
  console.log([
    'Two agents work on Shelf at once:',
    '  agent/backend  adds expiresAt to the POST /login response (types, route, contract test)',
    '  agent/frontend shows the session expiry on the welcome header, and asks agent/backend about the response first',
    'Both touch src/shared/types.ts, the API contract, so the harness should see the overlap.',
  ].join('\n'));
  console.log(`\n$ harness agent add backend\n${indent(await cli('agent', 'add', 'backend'))}`);
  console.log(`$ harness agent add frontend\n${indent(await cli('agent', 'add', 'frontend'))}`);

  const T_API = 'T-1';
  const T_WEB = 'T-2';
  const wt = (task: string) => daemon.worktreeOf('prj_shelf', task);
  const step = (tool: string, input: unknown) => `#STEP ${tool} ${JSON.stringify(input)}`;
  /** A scripted Read then Edit; checks the text to replace really is in Shelf, once. */
  const edit = (task: string, file: string, oldString: string, newString: string) => {
    if (fs.readFileSync(path.join(repo, file), 'utf8').split(oldString).length !== 2) throw new Error(`Shelf changed: ${file} no longer has the text the demo edits`);
    return [step('Read', { file_path: `${wt(task)}/${file}` }), step('Edit', { file_path: `${wt(task)}/${file}`, old_string: oldString, new_string: newString })];
  };
  const LOGIN_TYPE = '  token: string;\n  user: User;\n};';
  const backendText = REAL
    ? [
      'Change POST /login so its response also includes `expiresAt`: an ISO 8601 timestamp of when the session expires (sessions last SESSION_HOURS hours, see src/server/auth.ts).',
      'Update the LoginResponse type in src/shared/types.ts, the route in src/server/routes.ts, and the login check in test/contract/api.contract.test.ts. Run `npm test`.',
      'Another agent may ask you about this change; answer it with the `answer` tool. When the tests pass, call `report_done`.',
    ].join('\n')
    : [
      'Add expiresAt to the POST /login response. (Scripted for the demo; the harness runs it like any task.)',
      ...edit(T_API, 'src/shared/types.ts', LOGIN_TYPE, '  token: string;\n  user: User;\n  expiresAt: string; // ISO 8601: when the session ends\n};'),
      ...edit(T_API, 'src/server/routes.ts', "import { verifyPassword } from './auth.ts';", "import { SESSION_HOURS, verifyPassword } from './auth.ts';"),
      step('Edit', {
        file_path: `${wt(T_API)}/src/server/routes.ts`,
        old_string: '        const out: LoginResponse = { token: createSession(db, row.id, now()), user: toUser(row) };',
        new_string: '        const at = now();\n        const expiresAt = new Date(at.getTime() + SESSION_HOURS * 3600_000).toISOString();\n        const out: LoginResponse = { token: createSession(db, row.id, at), user: toUser(row), expiresAt };',
      }),
      ...edit(T_API, 'test/contract/api.contract.test.ts', "assertShape(r.body, { token: 'string', user: USER });", "assertShape(r.body, { token: 'string', user: USER, expiresAt: 'string' });"),
      '#STEP TEXT The login change is in place.',
      // Next turn: the question arrives. The scripted reply finds its id in the delivered message.
      step('mcp__harness__answer', { question_id: '{{find:KIND: question   ID: (msg_[0-9a-f]+)}}', text: 'Yes: POST /login now returns { token, user, expiresAt }. expiresAt is an ISO 8601 timestamp, 12 hours after login.' }),
      '#STEP TEXT Answered.',
      // Next turn: the overlap notice. Run the tests and finish.
      step('Bash', { command: 'npm test 2>&1 | grep -E "^ℹ (pass|fail)"' }),
      step('mcp__harness__report_done', { summary: 'POST /login returns expiresAt' }),
      '#STEP TEXT Done.',
    ].join('\n');
  const frontendText = REAL
    ? [
      'Show when the session expires on the welcome header (renderWelcome in src/client/views.ts).',
      'agent/backend is changing the POST /login response right now. Before you change anything, use the `ask` tool to ask agent/backend what the response will contain, then carry on while you wait for the answer.',
      'Update the LoginResponse type in src/shared/types.ts if you need to. Run `npm test`, then call `report_done`.',
    ].join('\n')
    : [
      'Show the session expiry on the welcome header. (Scripted for the demo.)',
      step('mcp__harness__harness_status', {}),
      step('mcp__harness__ask', { to: 'agent/backend', text: 'Is the POST /login response changing? The welcome header renders it.', about_paths: ['src/shared/types.ts'] }),
      step('Bash', { command: 'sleep 5; echo "sketched the header"' }),
      ...edit(T_WEB, 'src/shared/types.ts', LOGIN_TYPE, '  token: string;\n  user: User;\n  expiresAt?: string;\n};'),
      ...edit(T_WEB, 'src/client/views.ts', '<span class="email">${escapeHtml(login.user.email)}</span></header>`;',
        '<span class="email">${escapeHtml(login.user.email)}</span>${login.expiresAt ? ` <span class="expires">until ${escapeHtml(login.expiresAt.slice(11, 16))} UTC</span>` : \'\'}</header>`;'),
      step('mcp__harness__report_done', { summary: 'Welcome header shows the session expiry' }),
      '#STEP TEXT Done.',
    ].join('\n');

  // The backend agent starts first; the scripted version waits until it has made its change.
  console.log(`$ harness task add "Add expiresAt to the login response" --scope src/server/,src/shared/types.ts,test/contract/ --assign backend --text …\n${indent(await cli('task', 'add', 'Add expiresAt to the login response', '--scope', 'src/server/,src/shared/types.ts,test/contract/', '--assign', 'backend', '--text', backendText))}`);
  if (!REAL) await until('agent/backend to make its change', () => turnEnds(T_API) >= 1, 180_000);
  console.log(`$ harness task add "Show the session expiry" --scope src/client/ --assign frontend --text …\n${indent(await cli('task', 'add', 'Show the session expiry', '--scope', 'src/client/', '--assign', 'frontend', '--text', frontendText))}`);

  // Watch it play out. The snapshot is taken at the event where the overlap appears (both agents at
  // work), or failing that, the last moment both were alive.
  type Snapshot = { status: string; agentStatus: string; alive: string[]; claims: Record<string, string[]> };
  const take = (): Snapshot => ({
    status: renderHumanStatus(view),
    agentStatus: renderAgentStatus(view, [...view.agents.values()].find((a) => a.name === 'agent/frontend')!.id),
    alive: [...view.agents.values()].filter((a) => { const s = view.liveSession(a.id); return s && ['working', 'idle', 'waiting'].includes(s.status); }).map((a) => a.name),
    claims: Object.fromEntries([...view.claims].map(([t, c]) => [t, [...c.observed].sort()])),
  });
  const done = () => [T_API, T_WEB].every((t) => events('worktree.committed').some((e) => (e.data as { task_id: string }).task_id === t)
    || ['abandoned', 'done'].includes(view.tasks.get(t)?.status ?? '') && !daemon.running.has(t) && !daemon.lifecycles.has(t));
  let atOverlap: Snapshot | null = null;
  let bothAlive: Snapshot | null = null;
  onEvent = (e) => {
    if (atOverlap || e.kind !== 'overlap.detected' || (e.data as { level: string }).level !== 'observed') return;
    atOverlap = take();
    say('overlap detected; took a status snapshot');
  };
  let deadline = Date.now() + (REAL ? 15 * 60_000 : 180_000);
  let nudged = false;
  while (!done()) {
    if (!atOverlap) {
      const s = take();
      if (s.alive.length === 2) bothAlive = s;
    }
    if (Date.now() > deadline) {
      if (nudged) throw new Error('the tasks did not finish');
      // An agent that never calls report_done is finished by its human: that's an intervention (M5).
      for (const t of [T_API, T_WEB]) {
        if (view.tasks.get(t)?.status === 'in_progress') console.log(`$ harness task done ${t}\n${indent(await cli('task', 'done', t))}`);
      }
      nudged = true;
      deadline = Date.now() + 120_000;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const snapshot = atOverlap ?? bothAlive ?? take();

  section('harness status (while both agents were working)');
  console.log(indent(snapshot.status));
  section('What agent/frontend sees with harness_status (at the same moment)');
  console.log(indent(snapshot.agentStatus));
  section('harness status (at the end)');
  console.log(indent(await cli('status')));

  // ---------- the exit criteria (S3) ----------
  section('0A exit criteria');
  const name = (id: string | null) => view.agentName(id);
  const checks: [string, boolean, string][] = [];
  const tasks = [view.tasks.get(T_API), view.tasks.get(T_WEB)];
  checks.push(['Which agents are alive', snapshot.alive.length === 2,
    `live sessions at the snapshot: ${snapshot.alive.join(', ') || 'none'}; device ${[...view.devices].map(([d, s]) => `${d} ${s.online ? 'online' : 'offline'}`).join(', ')}`]);
  checks.push(['Which task each agent owns', tasks.every((t) => t?.assignee) && [...view.sessions.values()].every((s) => view.tasks.get(s.taskId)?.assignee === s.agentId),
    tasks.map((t) => `${t?.id} → ${name(t?.assignee ?? null)}`).join(', ')]);
  checks.push(['What each agent is currently modifying', [T_API, T_WEB].every((t) => (snapshot!.claims[t] ?? []).length > 0),
    [T_API, T_WEB].map((t) => `${t}: ${(snapshot!.claims[t] ?? []).join(', ') || 'nothing'}`).join('; ')]);
  checks.push(['What the other agents are working on', /agent\/backend: working on T-1/.test(snapshot.agentStatus) && /changing: .*src\/shared\/types\.ts/.test(snapshot.agentStatus),
    'agent/frontend\'s harness_status lists agent/backend\'s task and the files it is changing']);
  const overlap = events('overlap.detected').find((e) => (e.data as { level: string }).level === 'observed');
  const conflicts = [...view.messages.values()].filter((m) => m.kind === 'claim_conflict');
  checks.push(['When work likely overlaps', !!overlap && conflicts.length >= 1,
    overlap ? `${(overlap.data as { paths: string[] }).paths.join(', ')} between ${(overlap.data as { tasks: string[] }).tasks.join(' and ')}; claim_conflict to ${conflicts.map((m) => `${name(m.to)} (${m.deliveredAt ? `delivered ${m.delivery}` : 'not delivered'})`).join(', ')}` : 'no overlap seen']);
  const q = [...view.messages.values()].find((m) => m.kind === 'question');
  const a = q && [...view.messages.values()].find((m) => m.kind === 'answer' && m.inReplyTo === q.id);
  const qa = !!(q?.deliveredAt && a?.deliveredAt);
  checks.push(['A asks B; B\'s answer reaches A at a safe boundary, with latency and delivery point', qa,
    qa ? `question ${name(q!.from)} → ${name(q!.to)}: ${q!.delivery} after ${duration(q!.latencyMs ?? 0)}; answer → ${name(a!.to)}: ${a!.delivery} after ${duration(a!.latencyMs ?? 0)}; round trip ${duration(Date.parse(a!.deliveredAt!) - Date.parse(q!.sentAt))}`
      : `question ${q ? (q.deliveredAt ? 'delivered' : 'sent, not delivered') : 'never asked'}; answer ${a ? (a.deliveredAt ? 'delivered' : 'sent, not delivered') : 'none'}`]);
  for (const [what, ok, evidence] of checks) {
    console.log(`${ok ? '✔' : '✖'} ${what}\n    ${evidence}`);
    if (!ok) failed = true;
  }

  if (mock) {
    const ran = mock.log.filter((e) => e.kind === 'main').flatMap((e) => (e.summary ?? []) as { blocks: { type: string; text?: string }[] }[])
      .flatMap((m) => m.blocks).find((b) => b.type === 'tool_result' && /ℹ pass/.test(b.text ?? ''));
    if (ran) console.log(`\nShelf's tests, as agent/backend ran them in its sandbox: ${ran.text!.trim().replace(/\n/g, ', ')}`);
  }
  section('The work, committed by harnessd (D-50)');
  for (const e of events('worktree.committed')) {
    const d = e.data as { task_id: string; branch: string; commit: string };
    console.log(`  ${d.task_id} on ${d.branch}: ${execFileSync('git', ['-C', repo, 'log', '-1', '--format=%h %an: %s', d.commit], { encoding: 'utf8' }).trim()}`);
  }
  section('Metrics (validation.md §4)');
  console.log(indent(renderMetrics(computeMetrics(view))));
  if (KEEP) console.log(`\nKept ${root}: the Shelf repo with both task branches, the worktrees, and harnessd's home. Schema ${schema} is kept too.`);
  console.log(`\n${failed ? '✖ Some 0A exit criteria were not met.' : '✔ All 0A exit criteria met.'}${REAL ? '' : ' (Scripted model: run with --real and an API key to see real agents do it.)'}`);
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

