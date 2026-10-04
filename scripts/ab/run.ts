#!/usr/bin/env node
// The A/B runner, harness arm (B9a; docs/validation.md §3, §8). Each run starts from a fresh clone of the
// benchmark repo at the scenario's tag, assigns both of the scenario's tasks at once from its cards (the
// same phrasing in both arms of a pair), and ends when both tasks have landed, at the time cap, or when the
// coordinator stops it (Ctrl-C). The setup and test commands are approved before the run starts, so the
// human approves nothing during it.
//
//   node scripts/ab/run.ts --scenario SC-1 --phrasing 1 --real --provider deepseek [--repeat 3] [--cap-min 60]
//   node scripts/ab/run.ts --scenario SC-0 --dry --auto-land          the pipeline check: scripted model, free
//
//   --phrasing n   the cards' nth phrasing (1-3): paired run n uses phrasing n in both arms
//   --auto-land    the runner lands each task once it's done. Otherwise the coordinator lands with
//                  `harness land` (the HARNESS_HOME to use is printed); that counts as M5c
//   --dry          scripted stand-in agents that make a trivial change and report done: they check the
//                  runner, not the task. Counted runs use --real
//   --out <dir>    default runs/ (git-ignored);  --bench <path|url>  default: the card's repo
//   --budget-usd   per session (default 2);  --keep  keep the temp dir and schema
//
// Output, arm-blinded for grading (B11):
//   <out>/grade/<run-id>/        the final tree of main, without .git: all the grader gets
//   <out>/grade/<run-id>.json    { run_id, scenario }
//   <out>/record/<run-id>/       meta.json (arm, scenario, phrasing, outcome), events.jsonl, metrics.json and
//                                metrics.txt, timeline.jsonl, run.log: the coordinator's side, never the grader's
// Needs Postgres (README "Running locally") and network for the clone and the setup command.
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parse as parseToml, stringify as toToml } from 'smol-toml';
import {
  Approvals, computeMetrics, Daemon, harnessHome, parseConfig, renderMetrics, resolveProvider, type Home, type ResolvedProvider,
} from '../../packages/daemon/src/index.ts';
import { setupHash, testHash } from '../../packages/daemon/src/approvals.ts';
import { readRepoConfig } from '../../packages/daemon/src/repo-config.ts';
import { createPool, DEFAULT_DATABASE_URL, migrate } from '../../packages/server/src/db.ts';
import { startServer } from '../../packages/server/src/server.ts';
import { DUMMY_KEY, startMock } from '../../packages/adapters/test/mock-api.ts';
import { Recorder } from './recorder.ts';

export type CardTask = { key: string; agent: string; title: string; scope: string[]; phrasings: string[] };
export type Card = { scenario: string; name: string; repo: string; tag: string; tasks: CardTask[] };

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); const v = i >= 0 ? argv[i + 1] : undefined; return v?.startsWith('--') ? undefined : v; };
const flag = (name: string) => argv.includes(`--${name}`);
const fail = (msg: string): never => { console.error(msg); process.exit(2); };

const SCENARIO = opt('scenario') ?? fail('--scenario SC-n is required');
if (!/^SC-\d$/.test(SCENARIO)) fail(`not a scenario: ${SCENARIO}`);
const cardFile = path.resolve(import.meta.dirname, 'scenarios', `${SCENARIO}.json`);
if (!fs.existsSync(cardFile)) fail(`no cards for ${SCENARIO} (${cardFile})`);
const CARD = JSON.parse(fs.readFileSync(cardFile, 'utf8')) as Card;
const PHRASING = Number(opt('phrasing') ?? '1');
if (!Number.isInteger(PHRASING) || PHRASING < 1 || !CARD.tasks.every((t) => t.phrasings.length >= PHRASING)) fail(`--phrasing must be 1 to ${Math.min(...CARD.tasks.map((t) => t.phrasings.length))}`);
const REPEAT = Number(opt('repeat') ?? '1');
const CAP_MIN = Number(opt('cap-min') ?? '60');
const BUDGET = Number(opt('budget-usd') ?? '2');
const OUT = path.resolve(opt('out') ?? path.join(import.meta.dirname, '../../runs'));
const BENCH = opt('bench') ?? CARD.repo;
const DRY = flag('dry');
const REAL = flag('real');
const AUTO_LAND = flag('auto-land');
const KEEP = flag('keep');
const PROVIDER = opt('provider');
const PROVIDERS_FILE = opt('providers') ?? path.resolve(import.meta.dirname, '../../docs/examples/providers.toml');
if (DRY === REAL) fail('choose --real (a counted or rehearsal run, with --provider) or --dry (the scripted pipeline check)');
if (PROVIDER && !REAL) fail('--provider needs --real');
if (![REPEAT, CAP_MIN, BUDGET].every((n) => Number.isFinite(n) && n > 0)) fail('--repeat, --cap-min and --budget-usd must be positive');

const PROJECT = 'prj_ab';
const step = (tool: string, input: unknown) => `#STEP ${tool} ${JSON.stringify(input)}`;

/** A scripted stand-in for an agent: it writes one note in its worktree and reports done. It checks the runner, not the task. */
function dryProgram(task: CardTask, worktree: string): string {
  return [
    `${task.title}. (Dry run: a scripted stand-in that checks the A/B runner, not the task.)`,
    step('Write', { file_path: `${worktree}/dry-run/${task.key}.md`, content: `Dry run of ${CARD.scenario} ${task.key}.\n` }),
    step('mcp__harness__report_done', { summary: 'dry run' }),
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

let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  console.log('\nStopping the run (the coordinator ended it). Press Ctrl-C again to quit without saving.');
});

async function runOnce(n: number): Promise<string> {
  const runId = `r-${randomBytes(4).toString('hex')}`;
  const rec = new Recorder(path.join(OUT, 'record', runId));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ab-')));
  const cleanups: (() => Promise<void> | void)[] = [];
  const startedAt = new Date().toISOString();
  let outcome = 'error';
  rec.log(`run ${runId} (${n} of ${REPEAT}): ${CARD.scenario} ${CARD.name}, phrasing ${PHRASING}, harness arm${DRY ? ', dry' : ''}`);
  try {
    // The scenario's base: a fresh clone at its tag, on a local main, with no remote to fetch from.
    const repo = path.join(root, 'repo');
    execFileSync('git', ['clone', '-q', '--branch', CARD.tag, '--single-branch', '--no-tags', BENCH, repo], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-B', 'main']);
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'origin']);
    const baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    rec.mark('cloned', { tag: CARD.tag, base_sha: baseSha });

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

    const home = harnessHome(path.join(root, 'harness-home'));
    fs.mkdirSync(home.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(home.token, token, { mode: 0o600 });
    const agents: Record<string, unknown> = !REAL ? {} : PROVIDER ? {
      agents: { provider: PROVIDER, max_budget_usd: BUDGET },
      providers: { [PROVIDER]: ((parseToml(fs.readFileSync(PROVIDERS_FILE, 'utf8')) as { providers?: Record<string, unknown> }).providers ?? {})[PROVIDER]
        ?? fail(`no [providers.${PROVIDER}] in ${PROVIDERS_FILE}`) },
    } : { agents: { max_budget_usd: BUDGET } };
    const rawConfig = { device_id: 'dev_ab', principal: 'human_coordinator', server_url: server.url, limits: { port_range: [3300, 3399] }, ...agents, projects: [{ id: PROJECT, repo }] };
    fs.writeFileSync(home.config, toToml(rawConfig));
    const config = parseConfig(rawConfig, token);
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
    const cli = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(process.execPath, [path.resolve(import.meta.dirname, '../../packages/cli/src/main.ts'), ...args], { env: { ...process.env, HARNESS_HOME: home.root } });
      return stdout.trim();
    };

    // Both tasks at once. Task ids come from one sequence, so in a fresh schema they're T-1, T-2, … in card order.
    for (const t of CARD.tasks) await cli('agent', 'add', t.agent);
    const ids = new Map(CARD.tasks.map((t, i) => [t.key, `T-${i + 1}`]));
    rec.mark('started', { model });
    for (const t of CARD.tasks) {
      const id = ids.get(t.key)!;
      const text = DRY ? dryProgram(t, daemon.worktreeOf(PROJECT, id)) : t.phrasings[PHRASING - 1]!;
      await cli('task', 'add', t.title, '--scope', t.scope.join(','), '--assign', t.agent, '--text', text);
      rec.mark('assigned', { task: t.key, task_id: id, agent: `agent/${t.agent}` });
      rec.log(`assigned ${id} "${t.title}" to agent/${t.agent}`);
    }
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
    for (;;) {
      const finished = [...ids.values()].map((id) => (has('land.completed', id) ? 'landed' : has('task.abandoned', id) ? 'abandoned' : null));
      if (finished.every((f) => f !== null)) { outcome = finished.every((f) => f === 'landed') ? 'integrated' : 'abandoned'; break; }
      if (stopRequested) { outcome = 'stopped'; break; }
      if (Date.now() > deadline) { outcome = 'capped'; break; }
      for (const r of approvals.pending()) {
        if (pendingSeen.has(r.id)) continue;
        pendingSeen.add(r.id);
        rec.mark('approval_pending', { kind: r.kind ?? 'setup', command: r.command });
        rec.log(`an approval is pending (${r.kind ?? 'setup'}: "${r.command}"): a manifest changed during the run${DRY ? '; the dry run approves it' : '; approve it with `harness approve`'}`);
        if (DRY) approvals.approve(r.id);
      }
      if (AUTO_LAND) {
        const inFlight = [...view.lands.values()].some((l) => l.status === 'requested' || l.status === 'accepted');
        for (const id of ids.values()) {
          if (inFlight || !has('worktree.committed', id) || has('land.requested', id)) continue;
          rec.mark('land_requested', { task_id: id });
          rec.log(`landing ${id}: ${(await cli('land', id)).split('\n')[0]}`);
          break;
        }
        // The runner lands each task once; a failed land would wait for a human, so an auto-landed run ends here.
        const failed = [...ids.values()].find((id) => has('land.failed', id, (d) => d.reason !== 'cancelled'));
        if (failed) {
          outcome = 'land_failed';
          rec.log(`the land of ${failed} failed`);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    rec.mark('ended', { outcome });
    rec.log(`run ended: ${outcome}`);
    await daemon.stop();

    // The coordinator's record: everything that names the arm.
    rec.writeLines('events.jsonl', view.events);
    const metrics = computeMetrics(view);
    rec.writeJson('metrics.json', metrics);
    fs.writeFileSync(path.join(rec.dir, 'metrics.txt'), `${renderMetrics(metrics)}\n`);
    // The grader's copy: main's tree and nothing else (no .git, no branch names, no authors).
    const gradeDir = path.join(OUT, 'grade', runId);
    fs.mkdirSync(gradeDir, { recursive: true });
    execFileSync('tar', ['-x', '-C', gradeDir], { input: execFileSync('git', ['-C', repo, 'archive', '--format=tar', 'main'], { maxBuffer: 512 * 1024 * 1024 }) });
    fs.writeFileSync(path.join(OUT, 'grade', `${runId}.json`), `${JSON.stringify({ run_id: runId, scenario: CARD.scenario }, null, 2)}\n`);
    rec.writeJson('meta.json', {
      run_id: runId, arm: 'harness', scenario: CARD.scenario, phrasing: PHRASING, dry: DRY, model, cap_min: CAP_MIN, budget_usd: BUDGET,
      bench: BENCH, tag: CARD.tag, base_sha: baseSha, main_sha: execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(),
      started_at: startedAt, ended_at: new Date().toISOString(), outcome,
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
console.log(`\n${outcomes.length} run(s): ${outcomes.join(', ')}. Give the grader ${path.join(OUT, 'grade')} only.`);
process.exit(outcomes.every((o) => o === 'integrated') ? 0 : 1);
