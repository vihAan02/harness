#!/usr/bin/env node
// P0, the pilot's cost probe (D-116): one real task of the first two-agent test (scripts/pilot/first-test/1-format.md),
// on a clone of this repository, by a real agent on the configured provider, under the pilot's session cap. Nothing
// lands and nothing is pushed: it measures what one such session costs, and whether it finishes inside $0.10.
//
//   node scripts/pilot/p0-cost.ts [--provider openrouter-haiku55] [--task scripts/pilot/first-test/1-format.md] [--budget-usd 0.10]
//
// Needs the provider's key in its variable (never printed), Postgres (HARNESS_DATABASE_URL), and network for npm ci.
// It runs locally with a local token, like demo:0b; the pilot's D-119 guard belongs to device-key harnessds.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml, stringify as toToml } from 'smol-toml';
import { Approvals, Daemon, harnessHome, parseConfig, resolveProvider } from '../../packages/daemon/src/index.ts';
import { createPool, DEFAULT_DATABASE_URL, migrate } from '../../packages/server/src/db.ts';
import { startServer } from '../../packages/server/src/server.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const PROVIDER = opt('provider') ?? 'openrouter-haiku55';
const TASK = path.resolve(opt('task') ?? path.join(REPO_ROOT, 'scripts/pilot/first-test/1-format.md'));
const BUDGET = Number(opt('budget-usd') ?? '0.10');
const t0 = Date.now();
const say = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-p0-')));
const cleanups: (() => Promise<void> | void)[] = [];

async function main() {
  const table = ((parseToml(fs.readFileSync(path.join(REPO_ROOT, 'docs/examples/providers.toml'), 'utf8')) as { providers?: Record<string, unknown> }).providers ?? {})[PROVIDER];
  if (!table) throw new Error(`no [providers.${PROVIDER}] in docs/examples/providers.toml`);
  const repo = path.join(root, 'repo');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', REPO_ROOT, repo]);
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-B', 'main']); // the base branch, whatever this checkout's branch is
  say(`cloned ${REPO_ROOT} at ${execFileSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()}`);

  const databaseUrl = process.env.HARNESS_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const schema = `p0_${randomBytes(6).toString('hex')}`;
  const admin = createPool(databaseUrl);
  await admin.query(`CREATE SCHEMA ${schema}`);
  cleanups.push(async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const pool = createPool(databaseUrl, schema);
  cleanups.push(() => pool.end());
  await migrate(pool);
  await pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_p0', 'P0')");
  await pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_p0', 'human_p0', 'this Mac')");
  await pool.query("INSERT INTO projects (id, name) VALUES ('prj_p0', 'P0')");
  await pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ('prj_p0', 'human_p0', 'owner')");
  const token = randomBytes(32).toString('hex');
  const server = await startServer({ pool, databaseUrl, schema, localToken: token, port: 0 });
  cleanups.push(() => server.close());

  const home = harnessHome(path.join(root, 'home'));
  fs.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(home.token, token, { mode: 0o600 });
  const raw = { device_id: 'dev_p0', principal: 'human_p0', server_url: server.url, limits: { port_range: [31700, 31799] },
    agents: { provider: PROVIDER, max_budget_usd: BUDGET }, providers: { [PROVIDER]: table }, projects: [{ id: 'prj_p0', repo }] };
  fs.writeFileSync(home.config, toToml(raw));
  const config = parseConfig(raw, token);
  const provider = resolveProvider(config, { ...process.env, HARNESS_PROVIDER: PROVIDER });
  say(`agent on ${provider.model?.id} via ${PROVIDER}, capped at $${BUDGET} for the session`);
  const daemon = new Daemon({ home, config, provider, heartbeatMs: 1000, approvalPollMs: 200, finishGraceMs: 30_000, log: (m) => say(`harnessd: ${m}`) });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  await daemon.ready();
  const approvals = new Approvals(home);
  const approver = setInterval(() => { for (const r of approvals.pending()) { say(`approving the ${r.kind ?? 'setup'} command: ${r.command}`); approvals.approve(r.id); } }, 200);
  cleanups.push(() => clearInterval(approver));

  // Async: the coordinator runs in this process, so a blocking call to the CLI would wait on itself.
  const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, [path.join(REPO_ROOT, 'packages/cli/src/main.ts'), ...args], { env: { ...process.env, HARNESS_HOME: home.root } })).stdout.trim();
  await cli('agent', 'add', 'p0');
  say(await cli('task', 'add', 'UI formatters', '--scope', 'packages/ui/', '--assign', 'p0', '--file', TASK));
  const view = daemon.view('prj_p0');
  const ended = () => [...view.sessions.values()].some((s) => s.taskId === 'T-1' && s.status === 'ended');
  for (const end = Date.now() + 25 * 60_000; !ended(); await new Promise((r) => setTimeout(r, 1000))) if (Date.now() > end) throw new Error('timed out after 25 minutes');
  await new Promise((r) => setTimeout(r, 3000)); // the commit and the last usage report

  const task = view.tasks.get('T-1')!;
  const sessions = [...view.sessions.values()].filter((s) => s.taskId === 'T-1');
  const usage = sessions.map((s) => view.usage.get(s.id)).filter((u) => u !== undefined);
  const cost = usage.reduce((a, u) => a + u.costUsd, 0);
  const wt = daemon.worktreeOf('prj_p0', 'T-1');
  const diff = execFileSync('git', ['-C', repo, 'diff', '--stat', `HEAD...harness/task/T-1`], { encoding: 'utf8' }).trim();
  console.log(`\n=== P0 ===`);
  console.log(`task status: ${task.status}${task.summary ? ` ("${task.summary}")` : ''}; sessions: ${sessions.map((s) => `${s.status}${s.endReason ? ` (${s.endReason})` : ''}`).join(', ')}`);
  console.log(`cost: $${cost.toFixed(4)} of the $${BUDGET} cap; ${JSON.stringify(usage.map((u) => ({ in: u.input, out: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheCreation, models: u.models })))}`);
  console.log(`time: ${((Date.now() - t0) / 1000).toFixed(0)} s in all`);
  console.log(`branch harness/task/T-1 vs base:\n${diff || '(no change)'}`);
  if (fs.existsSync(wt)) {
    try {
      execFileSync('node', ['--test', 'packages/ui/test/format.test.ts'], { cwd: wt, stdio: 'pipe' });
      console.log('its test passes here too: node --test packages/ui/test/format.test.ts');
    } catch (e) { console.log(`its test fails here: ${String((e as { stdout?: Buffer }).stdout ?? '').split('\n').filter((l) => /^ℹ|not ok/.test(l)).join(' | ')}`); }
  }
  return task.status === 'done' && cost <= BUDGET;
}

let exit = 0;
try {
  if (!(await main())) exit = 1;
} catch (e) {
  console.error(`\nP0 failed: ${(e as Error).stack ?? (e as Error).message}`);
  exit = 1;
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(exit);
