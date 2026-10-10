#!/usr/bin/env node
// harnessd against the real GitHub, before two humans spend time on it (D-114, D-115): on this Mac, with this human's
// own `gh` login, harnessd publishes a scripted task from a fresh clone of the real repository: the publish gate, the
// local approval, a push of harness/<project>/<epoch>/<task>, one PR with the template filled, polling its checks and
// reviews. Then `harness integrate` must refuse (no other code owner has approved it): GitHub's live rules were read.
// The PR is closed unmerged and its branch deleted.
//
//   node scripts/pilot/smoke-github.ts [--repo owner/name] [--keep-pr]
//
// The model is the scripted mock (free); the coordinator runs in this process on a throwaway schema
// (HARNESS_TEST_DATABASE_URL). Needs `gh auth login` (repo scope) and network. It opens a real PR, which runs real CI.
process.env.TMPDIR = '/tmp'; // the UI socket's path must fit macOS's 104 bytes
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { renderConfig, parseConfig } from '../../packages/daemon/src/config.ts';
import { Daemon } from '../../packages/daemon/src/daemon.ts';
import { harnessHome } from '../../packages/daemon/src/home.ts';
import { harnessd } from '../../packages/cli/src/harnessd.ts';
import { generateKeyPair, parsePrivateKey } from '../../packages/protocol/src/signing.ts';
import type { ProjectSnapshot } from '../../packages/protocol/src/index.ts';
import { startServer } from '../../packages/server/src/server.ts';
import { freshSchema, TEST_DATABASE_URL } from '../../packages/server/test/helpers.ts';
import { DUMMY_KEY, startMock } from '../../packages/adapters/test/mock-api.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const REPO = opt('repo') ?? 'vihAan02/harness';
const KEEP_PR = argv.includes('--keep-pr');
const run = promisify(execFile);
const t0 = Date.now();
const say = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${m}`);
const cleanups: (() => Promise<void> | void)[] = [];
let failed = false;
const until = async (what: string, pred: () => Promise<boolean>, ms: number) => {
  for (const end = Date.now() + ms; !(await pred()); await new Promise((r) => setTimeout(r, 1000))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

async function main() {
  const me = JSON.parse((await run('gh', ['api', 'user'])).stdout) as { login: string; id: number; name: string | null };
  say(`GitHub login ${me.login}; repository ${REPO}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsmoke-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'clone');
  await run('git', ['clone', '-q', `https://github.com/${REPO}.git`, repo]);
  say(`cloned ${REPO} at ${(await run('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'])).stdout.trim()}`);

  // The coordinator, in device-key mode, with one human, one device and one GitHub-mode project.
  const db = await freshSchema();
  cleanups.push(() => db.drop());
  const project = 'prj_smoke';
  const device = generateKeyPair();
  const human = 'human_smoke';
  await db.pool.query("INSERT INTO human_principals (id, display_name) VALUES ($1, 'Smoke')", [human]);
  await db.pool.query("INSERT INTO projects (id, name, integration_mode, github_repo) VALUES ($1, $1, 'github', $2)", [project, REPO]);
  await db.pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ($1, $2, 'owner')", [project, human]);
  await db.pool.query("INSERT INTO devices (id, human_id, name, public_key) VALUES ('dev_smoke', $1, 'this Mac', $2)", [human, device.publicKey]);
  const serverKey = generateKeyPair();
  const server = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, serverKey: parsePrivateKey(serverKey.privateKeyPem), port: 0 });
  cleanups.push(() => server.close());

  // This Mac's harnessd, as `harness setup` would configure it, with the scripted model and the human's own gh login.
  const home = harnessHome(path.join(root, 'home'));
  fs.mkdirSync(home.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(home.deviceKey, device.privateKeyPem, { mode: 0o600 });
  const raw = {
    device_id: 'dev_smoke', principal: human, server_url: server.url, auth: 'device-key', server_key: serverKey.publicKey,
    trust: { devices: { dev_smoke: { human, key: device.publicKey } } }, limits: { port_range: [31600, 31699] },
    agents: { max_budget_usd: 0.1, daily_budget_usd: 0.25 },
    projects: [{ id: project, repo, integration: 'github', remote: `https://github.com/${REPO}.git`, commit_name: me.name ?? me.login, commit_email: `${me.id}+${me.login}@users.noreply.github.com` }],
  };
  fs.writeFileSync(home.config, renderConfig(raw), { mode: 0o600 });
  const mock = await startMock();
  cleanups.push(() => mock.close());
  // The scripted model can't be prompt-injected, so this smoke may run beside a password-less loopback Postgres (D-119).
  process.env.HARNESS_ALLOW_TRUST_PG = '1';
  const daemon = new Daemon({
    home, config: parseConfig(raw, ''), deviceKey: parsePrivateKey(device.privateKeyPem), heartbeatMs: 1000, approvalPollMs: 200,
    auth: { mode: 'api-key', apiKey: DUMMY_KEY, baseUrl: mock.url }, uiSocket: path.join(home.root, 'run', 'harnessd.sock'),
    log: (m) => say(`harnessd: ${m}`),
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  await daemon.ready();

  const cli = async (...args: string[]) => (await run(process.execPath, [path.resolve(import.meta.dirname, '../../packages/cli/src/main.ts'), ...args], { env: { ...process.env, HARNESS_HOME: home.root } })).stdout.trim();
  await cli('agent', 'add', 'smoke');
  const wt = path.join(fs.realpathSync(home.root), 'worktrees', project, 'T-1');
  const file = 'docs/pilot-smoke.md';
  const script = [`Write the smoke file. (Scripted.) ${new Date().toISOString()}`,
    `#STEP Write ${JSON.stringify({ file_path: `${wt}/${file}`, content: `# Pilot smoke\n\nharnessd's publish path against the real GitHub (D-114). This PR is closed unmerged.\n` })}`,
    `#STEP mcp__harness__report_done ${JSON.stringify({ summary: 'smoke file written' })}`, '#STEP TEXT Done.'].join('\n');
  console.log(await cli('task', 'add', 'Pilot smoke: publish to the real GitHub', '--scope', 'docs/', '--assign', 'smoke', '--text', script));
  await until('the publish request', async () => new Approvals(home).pending().some((r) => r.kind === 'publish'), 180_000);
  console.log(await cli('approve', new Approvals(home).pending().find((r) => r.kind === 'publish')!.id, '--yes'));

  const snap = async () => ((await harnessd(home, 'snapshot', { project_id: project })) as ProjectSnapshot[])[0]!.tasks.find((t) => t.id === 'T-1')!;
  await until('the PR', async () => !!(await snap()).pr, 180_000);
  const pr = (await snap()).pr!;
  say(`harnessd opened PR #${pr.number}: ${pr.url} (head ${pr.head_sha.slice(0, 12)})`);
  cleanups.push(async () => {
    if (KEEP_PR) return say(`kept PR #${pr.number}`);
    await run('gh', ['pr', 'close', String(pr.number), '-R', REPO, '--delete-branch', '--comment', 'Pilot smoke (scripts/pilot/smoke-github.ts): harnessd published this through the real GitHub; closed unmerged, as the smoke always does.']).catch((e) => say(`closing PR #${pr.number} failed: ${(e as Error).message}`));
    say(`closed PR #${pr.number} and deleted its branch`);
  });
  const remote = (await run('gh', ['api', `repos/${REPO}/pulls/${pr.number}`])).stdout;
  const live = JSON.parse(remote) as { head: { ref: string; sha: string }; user: { login: string }; body: string };
  const checks: [string, boolean, string][] = [];
  checks.push(['harnessd pushed the task branch with the human\'s own gh login, and opened the PR as them',
    live.head.sha === pr.head_sha && live.user.login === me.login && live.head.ref.startsWith(`harness/${project}/`),
    `${live.head.ref} @ ${live.head.sha.slice(0, 12)}, opened by ${live.user.login}`]);
  const commit = JSON.parse((await run('gh', ['api', `repos/${REPO}/commits/${pr.head_sha}`])).stdout) as { commit: { author: { email: string }; message: string } };
  checks.push(['the commit is authored as the human\'s noreply identity, with the agent named in a trailer',
    commit.commit.author.email === raw.projects[0]!.commit_email && /Harness-Agent:/.test(commit.commit.message), `${commit.commit.author.email}; ${/Harness-Agent: .*/.exec(commit.commit.message)?.[0] ?? 'no trailer'}`]);
  checks.push(['the PR body is the repository\'s template, filled', /## What changed, and why/.test(live.body) && /## Tests run/.test(live.body), 'template sections present']);
  // The poller brings GitHub's checks into harnessd's view (they start running as soon as the PR exists).
  await until('the PR\'s checks in harnessd\'s view', async () => Object.keys((await snap()).pr?.checks ?? {}).length > 0, 240_000).catch(() => {});
  const seen = (await snap()).pr!;
  checks.push(['harnessd polls the PR: its checks reach the view', Object.keys(seen.checks).length > 0, JSON.stringify(seen.checks)]);
  // Integrate must refuse: the other code owner hasn't approved this head (and its checks may still be running). The CLI
  // signs the dispatch; harnessd's pre-checks read GitHub's rules, reviews and running checks, and fail the land.
  const said = await cli('integrate', 'T-1', '--yes').then((o) => o, (e: { stderr?: string; message: string }) => `refused: ${e.stderr ?? e.message}`);
  if (!said.startsWith('refused')) await until('the land to end', async () => ['failed', 'rejected', 'completed'].includes((await snap()).land?.status ?? ''), 120_000).catch(() => {});
  const land = (await snap()).land;
  checks.push(['harness integrate refuses a head no other code owner approved, from GitHub\'s live rules', said.startsWith('refused') || (!!land && land.status !== 'completed'),
    `${said.trim().split('\n').at(-1)}; ${land ? `land ${land.status}: ${land.reason ?? ''} ${land.detail ?? ''}` : 'no land'}`]);
  for (const [what, ok, evidence] of checks) {
    console.log(`${ok ? '✔' : '✖'} ${what}\n    ${evidence}`);
    if (!ok) failed = true;
  }
  console.log(`\n${failed ? '✖ The GitHub smoke failed.' : '✔ harnessd publishes, polls and checks integration against the real GitHub.'}`);
}

let exit = 0;
try {
  await main();
  if (failed) exit = 1;
} catch (e) {
  console.error(`\nsmoke failed: ${(e as Error).stack ?? (e as Error).message}`);
  exit = 1;
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch (e) { console.error(`cleanup: ${(e as Error).message}`); } }
}
process.exit(exit);
