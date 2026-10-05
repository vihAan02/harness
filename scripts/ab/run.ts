#!/usr/bin/env node
// The A/B runner, both arms (B9a, B9b; docs/validation.md §3, §8, §9). Each run starts from a fresh clone of
// the benchmark repo at the scenario's tag (checked against the card's base_sha), assigns both of the
// scenario's tasks at once from its cards, and ends when both tasks are integrated, at the time cap, or when
// the coordinator stops it (Ctrl-C, or `stop` in the console).
// - Harness arm: harnessd runs both agents; the coordinator lands each task with `harness land`. The setup
//   and test commands are approved before the run, so the coordinator normally approves nothing during it; if
//   a manifest changes mid-run, the approval is asked for and recorded (M5c).
// - Baseline arm (baseline-arm.ts): two interactive Claude Code sessions with the same policy and none of the
//   treatment, one per terminal; the coordinator relays by hand and integrates with the console's `merge`.
// While a run goes, the console takes Enter (the M10 timer), `note <text>`, `stop`, and in the baseline
// `merge <agent>` and `sync <agent>` (validation.md §9).
//
//   node scripts/ab/run.ts --arm harness --scenario SC-1 --phrasing 2 --real --provider openrouter     one counted run
//   node scripts/ab/run.ts --arm baseline --scenario SC-1 --phrasing 2 --real --provider openrouter    its pair
//   node scripts/ab/run.ts --arm baseline --scenario SC-0 --dry --auto-land                           the pipeline check: free
//
//   --arm a        harness (default) or baseline
//   --launch l     baseline only: terminal (two Terminal.app windows; default), print (the two commands, to
//                  start by hand), or headless (the runner's own pseudo-terminals: dry runs and rehearsals)

//   --phrasing n   the cards' nth phrasing (1-3). Paired run n uses phrasing n in both arms, so --real needs it.
//                  With --repeat k, run i uses phrasing n+i-1.
//   --repeat k     k runs, one after another (default 1)
//   --auto-land    the runner integrates each task once it's done (dry runs and rehearsals). Otherwise the
//                  coordinator lands with `harness land` (the HARNESS_HOME to use is printed), or in the
//                  baseline uses `merge`; either counts as M5c
//   --dry          scripted stand-in agents that make a trivial change and report done: they check the
//                  runner, not the task. Counted runs use --real
//   --cap-min m    the time cap (default 60);  --budget-usd d  per session (default 2)
//   --out <dir>    default runs/ (git-ignored);  --bench <path|url>  default: the card's repo
//   --keep         keep the temp dir and schema;  --help
//
// Output, arm-blinded for grading (B11):
//   <out>/grade/<run-id>/        main's tree when the run ended, without .git, every file dated 2000-01-01:
//                                all the grader gets. Hand it over packed once, in shuffled order (B11), never
//                                as the live directory, whose own times still tell when each run was saved.
//   <out>/grade/<run-id>.json    { run_id, scenario }
//   <out>/record/<run-id>/       meta.json (arm, scenario, phrasing, outcome), summary.json (the measurements
//                                both arms share, scripts/ab/summary.ts), diffs/, transcripts/, timeline.jsonl,
//                                run.log; in the harness arm also events.jsonl and the metrics (rebuilt from
//                                the database after the stop): the coordinator's side, never the grader's
// Needs Postgres (README "Running locally") and network for the clone and the setup command.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { parse as parseToml, stringify as toToml } from 'smol-toml';
import {
  Approvals, computeMetrics, Daemon, harnessHome, parseConfig, ProjectView, renderMetrics, resolveProvider, type Home, type ResolvedProvider,
} from '../../packages/daemon/src/index.ts';
import { setupHash, testHash } from '../../packages/daemon/src/approvals.ts';
import { readRepoConfig } from '../../packages/daemon/src/repo-config.ts';
import { PROTOCOL_VERSION, type EventMessage } from '../../packages/protocol/src/index.ts';
import { createPool, DEFAULT_DATABASE_URL, migrate } from '../../packages/server/src/db.ts';
import { readEvents } from '../../packages/server/src/events.ts';
import { startServer } from '../../packages/server/src/server.ts';
import { DUMMY_KEY, startMock } from '../../packages/adapters/test/mock-api.ts';
import { agentConfigDir } from '../../packages/daemon/src/resources.ts';
import { runBaseline } from './baseline-arm.ts';
import { CoordinatorConsole } from './console.ts';
import { Recorder } from './recorder.ts';
import { copyTranscripts, harnessSummary, writeDiffs } from './summarize.ts';
import type { RunSummary } from './summary.ts';

export type CardTask = { key: string; agent: string; title: string; scope: string[]; phrasings: string[] };
export type Card = { scenario: string; name: string; repo: string; tag: string; base_sha?: string; tasks: CardTask[] };

const USAGE = 'usage: node scripts/ab/run.ts [--arm harness|baseline] [--launch terminal|print|headless] --scenario SC-n (--real --provider <name> --phrasing n | --dry) [--repeat k] [--auto-land] [--cap-min m] [--budget-usd d] [--out dir] [--bench path|url] [--providers file] [--keep]';
const fail = (msg: string): never => { console.error(`${msg}\n${USAGE}`); process.exit(2); };
let values: Record<string, string | boolean | undefined> = {};
try {
  ({ values } = parseArgs({
    strict: true, allowPositionals: false,
    options: {
      arm: { type: 'string' }, launch: { type: 'string' }, scenario: { type: 'string' }, phrasing: { type: 'string' }, repeat: { type: 'string' }, 'cap-min': { type: 'string' }, 'budget-usd': { type: 'string' },
      out: { type: 'string' }, bench: { type: 'string' }, provider: { type: 'string' }, providers: { type: 'string' },
      dry: { type: 'boolean' }, real: { type: 'boolean' }, 'auto-land': { type: 'boolean' }, keep: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  fail((e as Error).message); // an unknown flag, or one missing its value
}
if (values.help) { console.log(USAGE); process.exit(0); }
const str = (k: string) => values[k] as string | undefined;

const SCENARIO = str('scenario') ?? fail('--scenario SC-n is required');
if (!/^SC-\d$/.test(SCENARIO)) fail(`not a scenario: ${SCENARIO}`);
const cardFile = path.resolve(import.meta.dirname, 'scenarios', `${SCENARIO}.json`);
if (!fs.existsSync(cardFile)) fail(`no cards for ${SCENARIO} (${cardFile})`);
const CARD = JSON.parse(fs.readFileSync(cardFile, 'utf8')) as Card;
const DRY = values.dry === true;
const REAL = values.real === true;
const AUTO_LAND = values['auto-land'] === true;
const KEEP = values.keep === true;
if (DRY === REAL) fail('choose --real (a counted or rehearsal run, with --provider and --phrasing) or --dry (the scripted pipeline check)');
if (REAL && str('phrasing') === undefined) fail('--real needs --phrasing n: paired run n uses phrasing n in both arms');
const PHRASING = Number(str('phrasing') ?? '1');
const REPEAT = Number(str('repeat') ?? '1');
const CAP_MIN = Number(str('cap-min') ?? '60');
const BUDGET = Number(str('budget-usd') ?? '2');
const PHRASINGS = Math.min(...CARD.tasks.map((t) => t.phrasings.length));
if (!Number.isInteger(PHRASING) || !Number.isInteger(REPEAT) || PHRASING < 1 || REPEAT < 1 || PHRASING + REPEAT - 1 > PHRASINGS) {
  fail(`--phrasing and --repeat must pick from the cards' ${PHRASINGS} phrasings (run i of k uses phrasing n+i-1)`);
}
if (![CAP_MIN, BUDGET].every((n) => Number.isFinite(n) && n > 0)) fail('--cap-min and --budget-usd must be positive');
const OUT = path.resolve(str('out') ?? path.join(import.meta.dirname, '../../runs'));
const BENCH = str('bench') ?? CARD.repo;
const PROVIDER = str('provider');
const ARM = str('arm') ?? 'harness';
if (ARM !== 'harness' && ARM !== 'baseline') fail(`--arm is harness or baseline, not ${ARM}`);
// The scripted model has no terminal to type into: a dry baseline runs headless.
const LAUNCH = str('launch') ?? (DRY ? 'headless' : 'terminal');
if (!['terminal', 'print', 'headless'].includes(LAUNCH)) fail(`--launch is terminal, print or headless, not ${LAUNCH}`);
if (str('launch') && ARM !== 'baseline') fail('--launch is for the baseline arm');
if (ARM === 'baseline' && DRY && LAUNCH !== 'headless') fail('a dry baseline run is headless (the scripted model)');
if (ARM === 'baseline' && LAUNCH === 'headless' && !AUTO_LAND) fail('a headless baseline run has no coordinator at the terminals: add --auto-land');
const PROVIDERS_FILE = str('providers') ?? path.resolve(import.meta.dirname, '../../docs/examples/providers.toml');
if (PROVIDER && !REAL) fail('--provider needs --real');

const PROJECT = 'prj_ab';
/** Every file the grader gets carries this time, so nothing in the tree tells when its run ended. */
const FIXED_TIME = new Date('2000-01-01T00:00:00Z');
const step = (tool: string, input: unknown) => `#STEP ${tool} ${JSON.stringify(input)}`;

/**
 * A scripted stand-in for an agent: it writes one note in its worktree and says it's done (in the harness
 * arm, with `report_done`; the baseline has no harness tools). It checks the runner, not the task.
 */
function dryProgram(task: CardTask, worktree: string, harnessTools = true): string {
  return [
    `${task.title}. (Dry run: a scripted stand-in that checks the A/B runner, not the task.)`,
    step('Write', { file_path: `${worktree}/dry-run/${task.key}.md`, content: `Dry run of ${CARD.scenario} ${task.key}.\n` }),
    ...(harnessTools ? [step('mcp__harness__report_done', { summary: 'dry run' })] : []),
    '#STEP TEXT Done.',
  ].join('\n');
}

/** Approves the repo's setup and test commands for this project before the run (D-52, D-51), exactly as `harness approve` would. */
function preApprove(home: Home, repo: string): string[] {
  const rc = readRepoConfig(repo);
  const approvals = new Approvals(home);
  const done: string[] = [];
  for (const [kind, cmd] of [['setup', rc.setup], ['test', rc.test]] as const) {
    if (!cmd) continue;
    const h = (kind === 'test' ? testHash : setupHash)(repo, cmd.command, cmd.manifests);
    approvals.request({ projectId: PROJECT, taskId: 'pre-approved', command: cmd.command, manifests: h.manifests, hash: h.hash, kind });
    approvals.approve(h.hash.slice(0, 12));
    done.push(`${kind}: ${cmd.command}`);
  }
  return done;
}

/** Sets every file and directory under `dir`, and `dir` itself, to FIXED_TIME (children first). */
function fixTimes(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fixTimes(p);
    else fs.lutimesSync(p, FIXED_TIME, FIXED_TIME);
  }
  fs.utimesSync(dir, FIXED_TIME, FIXED_TIME);
}

/** The project's whole event log from the database: what actually committed, including what arrived during the stop. */
async function logFromDatabase(pool: ReturnType<typeof createPool>): Promise<EventMessage[]> {
  const out: EventMessage[] = [];
  for (let after = 0; ;) {
    const page = await readEvents(pool, PROJECT, after, 1000);
    if (!page.length) return out;
    for (const e of page) {
      out.push({
        v: PROTOCOL_VERSION, type: 'event', project_id: e.projectId, seq: e.seq, at: e.at.toISOString(),
        actor: { principal: e.actor, on_behalf_of: e.onBehalfOf, device_id: e.deviceId }, kind: e.kind, data: e.data as Record<string, unknown>,
      } as EventMessage);
    }
    after = page.at(-1)!.seq;
  }
}

/** The run's harness home and local config: harnessd's in the harness arm, the baseline launcher's in the other (the same provider and policy). */
function writeHome(root: string, serverUrl: string, token: string, repo: string): { home: Home; config: ReturnType<typeof parseConfig> } {
  const home = harnessHome(path.join(root, 'harness-home'));
  fs.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(home.token, token, { mode: 0o600 });
  const agents: Record<string, unknown> = !REAL ? {} : PROVIDER ? {
    agents: { provider: PROVIDER, max_budget_usd: BUDGET },
    providers: { [PROVIDER]: ((parseToml(fs.readFileSync(PROVIDERS_FILE, 'utf8')) as { providers?: Record<string, unknown> }).providers ?? {})[PROVIDER]
      ?? fail(`no [providers.${PROVIDER}] in ${PROVIDERS_FILE}`) },
  } : { agents: { max_budget_usd: BUDGET } };
  const rawConfig = { device_id: 'dev_ab', principal: 'human_coordinator', server_url: serverUrl, limits: { port_range: [3300, 3399] }, ...agents, projects: [{ id: PROJECT, repo }] };
  fs.writeFileSync(home.config, toToml(rawConfig));
  return { home, config: parseConfig(rawConfig, token) };
}

/**
 * The grader's copy: main's tree and nothing else (no .git, no branch names, no authors), every file dated
 * FIXED_TIME so the tree doesn't tell when the run ended (and with the schedule, which arm it was).
 */
function saveGradeTree(repo: string, mainSha: string, runId: string): void {
  const gradeDir = path.join(OUT, 'grade', runId);
  fs.mkdirSync(gradeDir, { recursive: true });
  execFileSync('tar', ['-x', '-C', gradeDir], { input: execFileSync('git', ['-C', repo, 'archive', '--format=tar', '--mtime=2000-01-01 00:00:00 +0000', mainSha], { maxBuffer: 512 * 1024 * 1024 }) });
  fixTimes(gradeDir);
  const gradeMeta = path.join(OUT, 'grade', `${runId}.json`);
  fs.writeFileSync(gradeMeta, `${JSON.stringify({ run_id: runId, scenario: CARD.scenario }, null, 2)}\n`);
  fs.utimesSync(gradeMeta, FIXED_TIME, FIXED_TIME);
}

let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  console.log('\nStopping the run (the coordinator ended it). Press Ctrl-C again to quit without saving.');
});

async function runOnce(n: number): Promise<string> {
  const runId = `r-${randomBytes(4).toString('hex')}`;
  const phrasing = PHRASING + n - 1;
  const rec = new Recorder(path.join(OUT, 'record', runId));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ab-')));
  const cleanups: (() => Promise<void> | void)[] = [];
  const startedAt = new Date().toISOString();
  let outcome = 'error';
  rec.log(`run ${runId} (${n} of ${REPEAT}): ${CARD.scenario} ${CARD.name}, phrasing ${phrasing}, ${ARM} arm${DRY ? ', dry' : ''}${AUTO_LAND ? ', auto-land' : ''}`);
  try {
    // The scenario's base: a fresh clone at its tag, on a local main, with no remote to fetch from.
    const repo = path.join(root, 'repo');
    execFileSync('git', ['clone', '-q', '--branch', CARD.tag, '--single-branch', '--no-tags', BENCH, repo], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-B', 'main']);
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin']);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const baseSha = git('rev-parse', 'HEAD');
    if (CARD.base_sha && baseSha !== CARD.base_sha) throw new Error(`${CARD.tag} is at ${baseSha}, but the card pins ${CARD.base_sha}: the scenario moved`);
    rec.mark('cloned', { tag: CARD.tag, base_sha: baseSha });
    // The coordinator's console (validation.md §9): the M10 timer, notes and `stop` in both arms, at a terminal.
    const con = process.stdin.isTTY ? new CoordinatorConsole(rec) : null;
    cleanups.push(() => con?.close());

    if (ARM === 'baseline') {
      // No server and no harnessd: the baseline launcher reads the same local config (provider, policy, ports).
      const { home, config } = writeHome(root, 'wss://example.invalid', randomBytes(32).toString('hex'), repo);
      let provider: ResolvedProvider | null = null;
      let mockUrl: string | null = null;
      if (REAL) {
        provider = resolveProvider(config, { ...process.env, HARNESS_PROVIDER: PROVIDER ?? '' });
      } else {
        const mock = await startMock();
        cleanups.push(() => mock.close());
        mockUrl = mock.url;
      }
      const model = provider ? `${provider.model?.id ?? 'vendor default'}${provider.name ? ` (${provider.name})` : ''}` : 'scripted';
      con?.start();
      const r = await runBaseline({
        scenario: CARD.scenario, tasks: CARD.tasks, phrasing, capMs: CAP_MIN * 60_000, rec, root, repo, home, config, provider, mockUrl,
        launch: LAUNCH as 'terminal' | 'print' | 'headless', autoIntegrate: AUTO_LAND,
        prompt: (t, wt) => (DRY ? dryProgram(t, wt, false) : t.phrasings[phrasing - 1]!),
        stopRequested: () => stopRequested, console: con, harnessRoot: path.resolve(import.meta.dirname, '../..'),
      });
      outcome = r.outcome;
      await con?.close();
      const mainSha = r.summary.main_sha;
      rec.mark('ended', { outcome, main_sha: mainSha });
      writeDiffs(rec.dir, repo, baseSha, mainSha, r.commits);
      copyTranscripts(rec.dir, r.agents);
      const endedAt = new Date().toISOString();
      const summary: RunSummary = { ...r.summary, run_id: runId, phrasing, cap_ms: CAP_MIN * 60_000, started_at: startedAt, ended_at: endedAt, void: null };
      rec.writeJson('summary.json', summary);
      saveGradeTree(repo, mainSha, runId);
      rec.writeJson('meta.json', {
        run_id: runId, arm: 'baseline', scenario: CARD.scenario, phrasing, dry: DRY, auto_land: AUTO_LAND, launch: LAUNCH, model, cap_min: CAP_MIN,
        bench: BENCH, tag: CARD.tag, base_sha: baseSha, main_sha: mainSha, started_at: startedAt, ended_at: endedAt, outcome,
        tasks: summary.tasks.map((t) => ({ ...t, title: CARD.tasks.find((c) => c.key === t.key)?.title })),
      });
      rec.log(`saved: grade/${runId}/ (for the grader) and record/${runId}/ (yours)`);
      return outcome;
    }

    const databaseUrl = process.env.HARNESS_DATABASE_URL ?? DEFAULT_DATABASE_URL;
    const schema = `ab_${randomBytes(6).toString('hex')}`;
    const admin = createPool(databaseUrl);
    try { await admin.query(`CREATE SCHEMA ${schema}`); } catch (e) { throw new Error(`can't reach Postgres at ${databaseUrl} (${(e as Error).message}). See "Running locally" in README.md.`); }
    cleanups.push(async () => { if (!KEEP) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    const pool = createPool(databaseUrl, schema);
    cleanups.push(() => pool.end());
    await migrate(pool);
    await pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_coordinator', 'Coordinator')");
    await pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_ab', 'human_coordinator', 'the A/B machine')");
    await pool.query('INSERT INTO projects (id, name, repo_url) VALUES ($1, $2, $3)', [PROJECT, `A/B ${CARD.scenario}`, BENCH]);
    await pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ($1, 'human_coordinator', 'owner')", [PROJECT]);
    const token = randomBytes(32).toString('hex');
    const server = await startServer({ pool, databaseUrl, schema, localToken: token, port: 0 });
    cleanups.push(() => server.close());

    const { home, config } = writeHome(root, server.url, token, repo);
    let provider: ResolvedProvider | null = null;
    let mockUrl: string | null = null;
    if (REAL) {
      provider = resolveProvider(config, { ...process.env, HARNESS_PROVIDER: PROVIDER ?? '' });
    } else {
      const mock = await startMock();
      cleanups.push(() => mock.close());
      mockUrl = mock.url;
    }
    const model = provider ? `${provider.model?.id ?? 'vendor default'}${provider.name ? ` (${provider.name})` : ''}` : 'scripted';
    for (const a of preApprove(home, repo)) rec.log(`pre-approved ${a}`);

    const daemon = new Daemon({
      home, config, heartbeatMs: 1000, approvalPollMs: 200, finishGraceMs: 30_000, diffIntervalMs: 5000,
      ...(provider ? { provider } : { auth: { mode: 'api-key' as const, apiKey: DUMMY_KEY, baseUrl: mockUrl! } }),
      log: (m) => rec.log(`harnessd: ${m}`),
    });
    await daemon.start();
    cleanups.push(() => daemon.stop());
    await daemon.ready();
    const view = daemon.view(PROJECT);
    /** The real `harness` CLI. A failure throws: the run can't go on without its agents and tasks. */
    const cli = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(process.execPath, [path.resolve(import.meta.dirname, '../../packages/cli/src/main.ts'), ...args], { env: { ...process.env, HARNESS_HOME: home.root } });
      return stdout.trim();
    };
    /** The CLI for a land or its cancel: a non-zero exit (refused, failed, already over) comes back as its output, and the events decide. */
    const cliOutput = (...args: string[]) => cli(...args).catch((e: { stdout?: string; stderr?: string; message: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message);

    // Both tasks at once. Task ids come from one sequence, so in a fresh schema they're T-1, T-2, … in card order.
    for (const t of CARD.tasks) await cli('agent', 'add', t.agent);
    const ids = new Map(CARD.tasks.map((t, i) => [t.key, `T-${i + 1}`]));
    rec.mark('started', { model });
    for (const t of CARD.tasks) {
      const id = ids.get(t.key)!;
      const text = DRY ? dryProgram(t, daemon.worktreeOf(PROJECT, id)) : t.phrasings[phrasing - 1]!;
      await cli('task', 'add', t.title, '--scope', t.scope.join(','), '--assign', t.agent, '--text', text);
      rec.mark('assigned', { task: t.key, task_id: id, agent: `agent/${t.agent}` });
      rec.log(`assigned ${id} "${t.title}" to agent/${t.agent}`);
    }
    con?.start();
    if (!AUTO_LAND) {
      rec.log(`coordinator: in another terminal, export HARNESS_HOME=${home.root}`);
      rec.log('  then `npx harness status`, and `npx harness land <task>` once a task is done. Ctrl-C here ends the run.');
    }

    // Until both tasks have landed (or been abandoned), the cap, or the coordinator stops it.
    const deadline = Date.now() + CAP_MIN * 60_000;
    const has = (kind: string, task: string, pred: (d: Record<string, unknown>) => boolean = () => true) =>
      view.events.some((e) => e.kind === kind && (e.data as { task_id?: string }).task_id === task && pred(e.data as Record<string, unknown>));
    const pendingSeen = new Set<string>();
    const approvals = new Approvals(home);
    /** Auto-land: the commit each task was last landed at, the failed lands already handled, and reopens per task. */
    const landedAt = new Map<string, string>();
    const handledLands = new Set<string>();
    const reopens = new Map<string, number>();
    for (;;) {
      const finished = [...ids.values()].map((id) => (has('land.completed', id) ? 'landed' : has('task.abandoned', id) ? 'abandoned' : null));
      if (finished.every((f) => f !== null)) { outcome = finished.every((f) => f === 'landed') ? 'integrated' : 'abandoned'; break; }
      if (stopRequested || con?.stopRequested) { outcome = 'stopped'; break; }
      if (Date.now() > deadline) { outcome = 'capped'; break; }
      for (const r of approvals.pending()) {
        if (pendingSeen.has(r.id)) continue;
        pendingSeen.add(r.id);
        rec.mark('approval_pending', { kind: r.kind ?? 'setup', command: r.command });
        rec.log(`an approval is pending (${r.kind ?? 'setup'}: "${r.command}"): a manifest changed during the run${DRY ? '; the dry run approves it' : '; approve it with `harness approve`'}`);
        if (DRY) approvals.approve(r.id);
      }
      if (AUTO_LAND) {
        // The runner lands each task once its agent is done, as the coordinator would. A land that fails (tests,
        // a conflict) sends the task back to its agent with what failed, up to three times, as the baseline's
        // runner asks its agent to fix a failed merge (D-107; validation.md §9). A fencing rejection, or a
        // fourth failure, would wait for a human, so an auto-landed run ends there.
        const rejected = [...ids.values()].find((id) => has('land.rejected', id));
        if (rejected) { outcome = 'land_rejected'; rec.log(`the land of ${rejected} was rejected`); break; }
        let gaveUp: string | null = null;
        for (const id of ids.values()) {
          const last = [...view.lands.values()].filter((l) => l.taskId === id).at(-1);
          if (last?.status !== 'failed' || last.reason === 'cancelled' || handledLands.has(last.id)) continue;
          handledLands.add(last.id);
          if ((reopens.get(id) ?? 0) >= 3) { gaveUp = id; break; }
          reopens.set(id, (reopens.get(id) ?? 0) + 1);
          const what = `${last.reason}${last.detail ? `: ${last.detail.replace(/\s+/g, ' ').slice(-1500)}` : ''}`;
          rec.mark('reopen', { task_id: id, land_id: last.id, reason: last.reason });
          rec.log(`the land of ${id} failed (${last.reason}); reopening it: ${(await cliOutput('task', 'reopen', id, '--text',
            `Landing your work failed (${what}). Fix your work so it lands with the tests green, then report done.`)).split('\n')[0]}`);
        }
        if (gaveUp) { outcome = 'land_failed'; rec.log(`the land of ${gaveUp} failed a fourth time`); break; }
        const inFlight = [...view.lands.values()].some((l) => l.status === 'requested' || l.status === 'accepted');
        for (const id of ids.values()) {
          // Ready: done, with a commit no land has been asked for yet.
          const commit = view.events.findLast((e) => e.kind === 'worktree.committed' && (e.data as { task_id?: string }).task_id === id)?.data as { commit?: string } | undefined;
          if (inFlight || view.tasks.get(id)?.status !== 'done' || !commit?.commit || landedAt.get(id) === commit.commit) continue;
          landedAt.set(id, commit.commit);
          rec.mark('land_requested', { task_id: id });
          // --no-wait: the loop keeps watching the cap and Ctrl-C while the land runs.
          rec.log(`landing ${id}: ${(await cliOutput('land', id, '--no-wait')).split('\n')[0]}`);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // The tree the grader gets is main as the run ended; a land still in flight is cancelled, and awaited, so
    // its test process doesn't outlive the run.
    const mainSha = git('rev-parse', 'main');
    rec.mark('ended', { outcome, main_sha: mainSha });
    rec.log(`run ended: ${outcome}`);
    // The runner's cancels, not the coordinator's: meta.json lists them, so M5c can discount them.
    const cancelledAtEnd: string[] = [];
    for (const l of [...view.lands.values()].filter((x) => x.status === 'requested' || x.status === 'accepted')) {
      rec.mark('land_cancelled_at_end', { task_id: l.taskId });
      rec.log(`cancelling the land of ${l.taskId} still in flight: ${(await cliOutput('land', '--cancel', l.taskId)).split('\n')[0]}`);
      cancelledAtEnd.push(l.taskId);
    }
    await Promise.race([daemon.landing.get(PROJECT) ?? Promise.resolve(), new Promise((r) => setTimeout(r, 120_000))]);
    await daemon.stop();

    // The coordinator's record: everything that names the arm. Rebuilt from the database, which has what
    // committed while harnessd was stopping (the last session ends, the final usage) and its view doesn't.
    const events = await logFromDatabase(pool);
    const record = new ProjectView(PROJECT);
    for (const e of events) record.apply(e);
    if (events.length !== view.events.length) rec.log(`record: ${events.length} events in the database (the live view had ${view.events.length})`);
    rec.writeLines('events.jsonl', events);
    const metrics = computeMetrics(record);
    rec.writeJson('metrics.json', metrics);
    fs.writeFileSync(path.join(rec.dir, 'metrics.txt'), `${renderMetrics(metrics)}\n`);
    // The measurements both arms share (validation.md §9), and what the judge reads beside them.
    await con?.close();
    const summary = harnessSummary({
      runId, scenario: CARD.scenario, phrasing, outcome: outcome as RunSummary['outcome'], capMs: CAP_MIN * 60_000, startedAt, endedAt: new Date().toISOString(),
      view: record, metrics, ids, runnerCancels: cancelledAtEnd.length, m10Ms: con?.m10Ms() ?? 0, repo, baseSha, mainSha,
      tasks: CARD.tasks.map((t) => ({ key: t.key, agent: t.agent })),
    });
    rec.writeJson('summary.json', summary);
    writeDiffs(rec.dir, repo, baseSha, mainSha, CARD.tasks.map((t) => ({ key: t.key, commit: metrics.tasks.find((x) => x.id === ids.get(t.key))?.commit ?? null })));
    copyTranscripts(rec.dir, [...record.agents.values()].map((a) => ({ name: a.name, configDir: agentConfigDir(home, a.id) })));
    saveGradeTree(repo, mainSha, runId);
    rec.writeJson('meta.json', {
      run_id: runId, arm: 'harness', scenario: CARD.scenario, phrasing, dry: DRY, auto_land: AUTO_LAND, model, cap_min: CAP_MIN, budget_usd: BUDGET,
      bench: BENCH, tag: CARD.tag, base_sha: baseSha, main_sha: mainSha, started_at: startedAt, ended_at: new Date().toISOString(), outcome,
      events: events.length, approvals_mid_run: pendingSeen.size, runner_cancelled_lands: cancelledAtEnd,
      tasks: CARD.tasks.map((t) => ({ key: t.key, task_id: ids.get(t.key), agent: `agent/${t.agent}`, title: t.title, scope: t.scope })),
    });
    rec.log(`saved: grade/${runId}/ (for the grader) and record/${runId}/ (yours)`);
  } catch (e) {
    rec.mark('error', { message: (e as Error).message });
    rec.log(`run failed: ${(e as Error).message}`);
  } finally {
    for (const c of cleanups.reverse()) { try { await c(); } catch {} }
    if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
    else rec.log(`kept ${root}`);
  }
  return outcome;
}

const outcomes: string[] = [];
for (let n = 1; n <= REPEAT && !stopRequested; n++) outcomes.push(await runOnce(n));
console.log(`\n${outcomes.length} run(s): ${outcomes.join(', ')}. Give the grader ${path.join(OUT, 'grade')} only, packed (B11).`);
process.exit(outcomes.every((o) => o === 'integrated') ? 0 : 1);
