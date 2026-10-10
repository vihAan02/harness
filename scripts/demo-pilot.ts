#!/usr/bin/env node
// The pilot rehearsal on one Mac (D-110 to D-115, D-142): two humans, two devices, two harnessd processes, one
// coordinator in device-key mode, and GitHub mode, with every human step through the real `harness` CLI and every agent
// the real pinned Claude Code CLI under harnessd's sandbox. Only GitHub (test/fake-github.ts) and the model (the scripted
// mock) are stand-ins. It's a rehearsal, not proof that two physical Macs work: the tunnel, Tailscale and real GitHub
// are what the two-Mac run (scripts/pilot/README.md §5) adds.
//
//   npm run demo:pilot            scripted model, free, about two minutes
//   options: --keep               keep the temp dir for inspection
//
// What it checks, in order:
//   1. Two devices, two identities: each harnessd proves its own device key; each human's commands are signed through
//      their own harnessd's socket (D-111, D-112).
//   2. Stale context across devices through GitHub: B's agent reads src/format.ts; A's agent changes it and finishes;
//      A's human approves the publish, the PR goes green and reviewed, and `harness integrate` merges it through the
//      reservation; B's harnessd fetches that exact merge, syncs B's branch, and B's agent is told, with the diff,
//      then builds on the change; B's human integrates it the same way (D-92, D-106, D-114, D-115).
//   3. Agents talk across devices: B's agent asks A's agent a question and gets the answer (D-80).
//   4. Recovery: B's harnessd is killed (SIGKILL) mid-session; after a restart the task shows stopped with its edit
//      kept, and `harness task resume` finishes it with one push and one PR (D-113).
//
// Needs Postgres (README "Running locally"; HARNESS_TEST_DATABASE_URL) and no network.
process.env.TMPDIR = '/tmp'; // macOS caps Unix socket paths at 104 bytes; each home's harnessd.sock lives under it
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Approvals } from '../packages/daemon/src/approvals.ts';
import { harnessd } from '../packages/cli/src/harnessd.ts';
import type { ProjectSnapshot } from '../packages/protocol/src/index.ts';
import { DUMMY_KEY, startMock, type Mock } from '../packages/adapters/test/mock-api.ts';
import { startPilotStack, gitAsync, type PilotSide, type PilotStack } from '../test/support.ts';

const argv = process.argv.slice(2);
if (argv.includes('--real')) {
  console.error('demo:pilot runs the scripted model only: the real two-Mac run is scripts/pilot/README.md §5.');
  process.exit(2);
}
const KEEP = argv.includes('--keep');
const CLI = path.resolve(import.meta.dirname, '../packages/cli/src/main.ts');
const CHILD = path.resolve(import.meta.dirname, '../test/pilot/harnessd-child.ts');
const t0 = Date.now();
const say = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);
const section = (title: string) => console.log(`\n=== ${title} ===`);
const indent = (text: string) => text.split('\n').map((l) => `    ${l}`).join('\n');
const cleanups: (() => Promise<void> | void)[] = [];
let failed = false;

type Child = { proc: ChildProcess; lines: Record<string, unknown>[]; exited: Promise<unknown> };

async function main() {
  section('Harness pilot rehearsal: two devices, GitHub mode (scripted model; harnessd, the CLI, Claude Code, sandboxes, Git and the server are real)');
  const FORMAT = 'src/format.ts';
  const s = await startPilotStack({
    files: { 'README.md': 'pilot rehearsal\n', [FORMAT]: 'export function cost(usd: number): string {\n  return `$${usd.toFixed(2)}`;\n}\n' },
    daemons: false, portRanges: { a: [31400, 31499], b: [31500, 31599] },
  });
  cleanups.push(() => (KEEP ? undefined : s.stop()));
  const mock: Mock = await startMock();
  cleanups.push(() => mock.close());
  say(`coordinator (device-key) at ${s.server.url}; fake GitHub ${s.fake.webUrl}; project ${s.project}`);

  // ---------- the two harnessds, as `harnessd` runs on each Mac ----------
  const children: Record<'a' | 'b', Child | null> = { a: null, b: null };
  const start = async (side: 'a' | 'b'): Promise<Child> => {
    const sd = s[side];
    const proc = spawn(process.execPath, [CHILD], {
      // The scripted model can't be prompt-injected, so this rehearsal may run beside a password-less loopback Postgres;
      // a real agent never does (D-119): the two-Mac run hardens or stops it.
      env: {
        ...process.env, HARNESS_ALLOW_TRUST_PG: '1',
        HARNESS_CHILD: JSON.stringify({
          home: sd.home.root, raw: sd.raw, token: '', pilot: { githubToken: s.fake.token, retryMs: 100 },
          claude: { mockUrl: mock.url, apiKey: DUMMY_KEY }, uiSocket: path.join(sd.home.root, 'run', 'harnessd.sock'),
          timings: { approvalPollMs: 100, finishGraceMs: 30_000, diffIntervalMs: 2000 },
        }),
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    proc.stdout!.on('data', (d) => {
      buf += String(d);
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const l = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
        lines.push(l);
        if (typeof l.log === 'string') say(`harnessd ${side.toUpperCase()}: ${l.log}`);
      }
    });
    const exited = new Promise((r) => proc.once('exit', r));
    let gone = false;
    void exited.then(() => { gone = true; });
    await until(`harnessd ${side.toUpperCase()} to connect`, () => gone || lines.some((l) => l.ready), 60_000);
    if (gone) throw new Error(`harnessd ${side.toUpperCase()} exited at start`);
    children[side] = { proc, lines, exited };
    return children[side]!;
  };
  cleanups.push(async () => {
    for (const c of Object.values(children)) if (c && c.proc.exitCode === null && c.proc.signalCode === null) { c.proc.kill('SIGTERM'); await c.exited; }
  });
  await start('a');
  await start('b');

  // ---------- each human's own CLI, on their own home ----------
  const cli = async (sd: PilotSide, ...args: string[]) => {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, HARNESS_HOME: sd.home.root, HARNESS_TEST: '1' } });
    return stdout.trim();
  };
  const show = async (sd: PilotSide, who: string, ...args: string[]) => {
    const out = await cli(sd, ...args);
    console.log(`${who}$ harness ${args.map((a) => (a.includes('\n') ? '<script>' : a)).join(' ')}\n${indent(out)}`);
    return out;
  };
  const events = async (kind: string, task?: string) => (await s.db.pool.query<{ seq: string; data: Record<string, unknown> }>(
    `SELECT seq, data FROM events WHERE project_id = $1 AND kind = $2 ${task ? "AND data->>'task_id' = $3" : ''} ORDER BY seq`,
    task ? [s.project, kind, task] : [s.project, kind])).rows;
  const approvePublish = async (sd: PilotSide, who: string, task: string) => {
    await untilAsync(`${task}'s publish to ask ${who}`, async () => new Approvals(sd.home).pending().some((r) => r.kind === 'publish' && r.taskId === task), 120_000);
    const req = new Approvals(sd.home).pending().find((r) => r.kind === 'publish' && r.taskId === task)!;
    await show(sd, who, 'approve', req.id, '--yes');
  };
  /** The other human approves the PR's head on GitHub, CI is green (the fake's default), and the owner integrates it. */
  const integrate = async (sd: PilotSide, who: string, reviewer: string, task: string) => {
    await untilAsync(`${task}'s PR`, async () => (await events('pr.published', task)).length > 0, 120_000);
    const pr = (await events('pr.published', task)).at(-1)!.data as { pr_number: number; head_sha: string; url: string };
    say(`harnessd opened PR #${pr.pr_number} for ${task} (${pr.url}); ${reviewer} approves head ${pr.head_sha.slice(0, 12)} on GitHub`);
    s.fake.addReview(pr.pr_number, { login: reviewer, state: 'APPROVED', commit_id: pr.head_sha });
    // harnessd's poller brings the PR's status into its view before the human looks at it.
    await untilAsync(`${task}'s PR status in ${who}'s view`, async () => {
      const [snap] = (await harnessd(sd.home, 'snapshot', { project_id: s.project })) as ProjectSnapshot[];
      return !!snap?.tasks.find((x) => x.id === task)?.pr?.reviews.length;
    }, 60_000);
    await show(sd, who, 'integrate', task, '--yes');
    await untilAsync(`${task} to land`, async () => (await events('land.completed', task)).length > 0, 120_000);
    const landed = (await events('land.completed', task))[0]!.data as { new_base_sha: string };
    say(`${task} landed: GitHub squash-merged it as ${landed.new_base_sha.slice(0, 12)}`);
    return landed.new_base_sha;
  };
  const turnsEnded = (marker: string) => mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary ?? '').includes(marker)
    && Array.isArray(e.emitted) && e.emitted.some((c: { text?: string }) => c.text !== undefined)).length;

  await show(s.a, 'A', 'agent', 'add', 'a-ui');
  await show(s.b, 'B', 'agent', 'add', 'b-ui');
  const wt = (sd: PilotSide, task: string) => path.join(fs.realpathSync(sd.home.root), path.relative(sd.home.root, sd.home.worktrees), s.project, task);
  const step = (tool: string, input: unknown) => `#STEP ${tool} ${JSON.stringify(input)}`;

  // ---------- 2. stale context across devices, through GitHub ----------
  section('B\'s agent reads src/format.ts; A\'s agent changes it; the change lands through GitHub and reaches B');
  const T_B = 'T-1';
  const T_A = 'T-2';
  const NEW_FORMAT = "export function cost(usd: number, currency = 'USD'): string {\n  return `${currency} ${usd.toFixed(2)}`;\n}\n";
  const bText = ['Build a board total on cost(). (Scripted for the rehearsal.) [demo-b]',
    step('Read', { file_path: `${wt(s.b, T_B)}/${FORMAT}` }),
    '#STEP TEXT Read the formatter; waiting for agent/a-ui\'s change to land.',
    '#STEP TEXT Noted: agent/a-ui is changing src/format.ts.',
    step('Read', { file_path: `${wt(s.b, T_B)}/${FORMAT}` }),
    step('Write', { file_path: `${wt(s.b, T_B)}/src/board.ts`, content: "import { cost } from './format.ts';\n\nexport const total = (usd: number): string => cost(usd, 'EUR');\n" }),
    step('mcp__harness__report_done', { summary: 'board.ts uses cost(usd, currency)' }),
    '#STEP TEXT Done.'].join('\n');
  const aText = ['Give cost() a currency. (Scripted for the rehearsal.) [demo-a]',
    step('Read', { file_path: `${wt(s.a, T_A)}/${FORMAT}` }),
    step('Write', { file_path: `${wt(s.a, T_A)}/${FORMAT}`, content: NEW_FORMAT }),
    step('mcp__harness__report_done', { summary: 'cost() takes a currency' }),
    '#STEP TEXT Done.'].join('\n');
  await show(s.b, 'B', 'task', 'add', 'Board total', '--scope', 'src/board.ts', '--assign', 'b-ui', '--text', bText);
  await untilAsync('B\'s agent to read src/format.ts', async () => (await events('readset.added', T_B)).some((e) => JSON.stringify(e.data).includes(FORMAT)), 180_000);
  await until('B\'s first turn to end', () => turnsEnded('[demo-b]') >= 1, 120_000);
  say('B\'s agent (on device B) read src/format.ts at its base blob');
  await show(s.a, 'A', 'task', 'add', 'Currency in cost()', '--scope', FORMAT, '--assign', 'a-ui', '--text', aText);
  await approvePublish(s.a, 'A', T_A);
  const mergeA = await integrate(s.a, 'A', 'human-b', T_A);
  await untilAsync('B\'s agent to finish on top of the change', async () => (await events('task.completed', T_B)).length > 0, 180_000);
  await approvePublish(s.b, 'B', T_B);
  const mergeB = await integrate(s.b, 'B', 'human-a', T_B);

  // ---------- 3. agents talk across devices ----------
  section('B\'s agent asks A\'s agent a question, across devices');
  const T_A2 = 'T-3';
  const T_B2 = 'T-4';
  await show(s.a, 'A', 'task', 'add', 'Answer questions about cost()', '--scope', FORMAT, '--assign', 'a-ui', '--text', [
    'Answer agent/b-ui\'s question about cost(). (Scripted for the rehearsal.) [demo-a2]',
    '#STEP TEXT Ready for questions.',
    step('mcp__harness__answer', { question_id: '{{find:KIND: question\\s+ID: (\\S+)}}', text: 'Yes: cost(usd, currency) is the signature now; currency defaults to USD.' }),
    step('mcp__harness__report_done', { summary: 'answered agent/b-ui' }),
    '#STEP TEXT Done.'].join('\n'));
  await until('A\'s agent to be ready', () => turnsEnded('[demo-a2]') >= 1, 120_000);
  await show(s.b, 'B', 'task', 'add', 'Ask about cost()', '--scope', 'src/board.ts', '--assign', 'b-ui', '--text', [
    'Ask agent/a-ui about cost(). (Scripted for the rehearsal.) [demo-b2]',
    step('mcp__harness__ask', { to: 'agent/a-ui', text: 'Is cost(usd, currency) the signature to build on?' }),
    '#STEP TEXT Asked; waiting for the answer.',
    step('mcp__harness__report_done', { summary: 'got agent/a-ui\'s answer' }),
    '#STEP TEXT Done.'].join('\n'));
  await untilAsync('both message tasks to finish', async () => (await events('task.completed', T_A2)).length > 0 && (await events('task.completed', T_B2)).length > 0, 180_000);

  // ---------- 4. recovery ----------
  section('B\'s harnessd is killed mid-session, restarted, and the task resumed');
  const T_C = 'T-5';
  const NOTES = 'docs/notes.md';
  await show(s.b, 'B', 'task', 'add', 'Notes', '--scope', 'docs/', '--assign', 'b-ui', '--text', [
    'Write the notes. (Scripted for the rehearsal.) [demo-c]',
    step('Write', { file_path: `${wt(s.b, T_C)}/${NOTES}`, content: '# Notes\n\nWritten before the crash.\n' }),
    step('Bash', { command: 'sleep 12' }),
    step('mcp__harness__report_done', { summary: 'notes written' }),
    '#STEP TEXT Done.'].join('\n'));
  await until('the notes to be written', () => fs.existsSync(path.join(wt(s.b, T_C), NOTES)), 180_000);
  await new Promise((r) => setTimeout(r, 1500)); // into the sleep
  say('killing harnessd B with SIGKILL, mid-session');
  children.b!.proc.kill('SIGKILL');
  await children.b!.exited;
  await start('b');
  const stateOf = async (task: string) => ((await harnessd(s.b.home, 'snapshot', { project_id: s.project })) as ProjectSnapshot[])[0]!.tasks.find((x) => x.id === task);
  await untilAsync(`${T_C} to show stopped`, async () => (await stateOf(T_C))?.state === 'stopped', 60_000);
  const kept = fs.readFileSync(path.join(wt(s.b, T_C), NOTES), 'utf8').includes('before the crash');
  say(`${T_C} is stopped; its edit is ${kept ? 'still in the worktree' : 'GONE'}`);
  await show(s.b, 'B', 'task', 'resume', T_C, '--text', 'harnessd restarted; carry on.');
  await approvePublish(s.b, 'B', T_C);
  await untilAsync(`${T_C}'s PR`, async () => (await events('pr.published', T_C)).length > 0, 120_000);
  await new Promise((r) => setTimeout(r, 1500)); // several poll rounds: nothing more happens

  // ---------- the checks ----------
  section('Pilot rehearsal: what happened');
  const checks: [string, boolean, string][] = [];
  const devices = (await s.db.pool.query("SELECT id FROM devices WHERE id IN ('dev_a', 'dev_b') AND last_heartbeat_at IS NOT NULL ORDER BY id")).rows.map((r) => r.id);
  const started = async (task: string) => (await events('session.started', task)).map((e) => String(e.data.device_id ?? '?'));
  const sa = await started(T_A);
  const sb = await started(T_B);
  checks.push(['Two devices, two identities: each task ran on its own human\'s device, from a dispatch signed there',
    devices.length === 2 && sa.every((d) => d === 'dev_a') && sb.every((d) => d === 'dev_b') && sa.length === 1 && sb.length === 1,
    `devices online: ${devices.join(', ')}; ${T_A} on ${sa.join(',')}, ${T_B} on ${sb.join(',')}`]);
  const prA = s.fake.prs().find((p) => p.mergeCommitSha === mergeA);
  checks.push([`${T_A} was published by harnessd A and merged through GitHub as the approved squash`, !!prA?.merged && (await events('land.completed', T_A)).length === 1,
    prA ? `PR #${prA.number} "${prA.title}" merged as ${mergeA.slice(0, 12)}; one land.completed` : 'no merged PR']);
  const synced = (await events('worktree.synced', T_B)).find((e) => e.data.new_base_sha === mergeA || JSON.stringify(e.data).includes(mergeA.slice(0, 12)));
  const notice = mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary ?? '').includes('[demo-b]')).map((e) => JSON.stringify(e.summary)).find((t) => t.includes(`Dependency changed: ${FORMAT} has changed since you read it.`));
  checks.push([`B's harnessd fetched A's merge, synced ${T_B}, and B's agent was told, with the diff`,
    !!notice && notice.includes("currency = 'USD'") && (await events('worktree.synced', T_B)).length > 0,
    `${synced ? 'synced to the merge' : 'synced'}; the notice ${notice ? 'carried the sentence and a diff with the new signature' : 'never reached the model'}`]);
  const prB = s.fake.prs().find((p) => p.mergeCommitSha === mergeB);
  const builtOn = (await gitAsync(s.b.repo, 'show', `${mergeB}:src/board.ts`).catch(() => '')).includes("cost(usd, 'EUR')");
  checks.push([`${T_B} was built on A's change and integrated from device B`, !!prB?.merged && builtOn,
    `${prB ? `PR #${prB.number} merged as ${mergeB.slice(0, 12)}` : 'not merged'}; board.ts ${builtOn ? 'calls cost(usd, currency)' : 'is missing'}`]);
  const baseB = await gitAsync(s.b.repo, 'rev-parse', `refs/harness/${s.project}/base`).catch(() => '');
  const baseA = await gitAsync(s.a.repo, 'rev-parse', `refs/harness/${s.project}/base`).catch(() => '');
  checks.push(['Each Mac\'s own fetched base reached the merges, by Git alone', [mergeA, mergeB].includes(baseB) && baseA === mergeB,
    `device A's base ${baseA.slice(0, 12) || '—'}, device B's base ${baseB.slice(0, 12) || '—'} (merges ${mergeA.slice(0, 12)}, ${mergeB.slice(0, 12)})`]);
  const question = (await events('message.sent')).find((e) => e.data.kind === 'question');
  const answer = (await events('message.sent')).find((e) => e.data.kind === 'answer');
  const delivered = new Set((await events('message.delivered')).map((e) => String(e.data.message_id)));
  checks.push(['B\'s agent asked A\'s agent, and the answer came back, across devices',
    !!question && !!answer && delivered.has(String(question.data.message_id)) && delivered.has(String(answer.data.message_id)),
    `question ${question ? (delivered.has(String(question.data.message_id)) ? 'delivered to agent/a-ui' : 'not delivered') : 'not sent'}; answer ${answer ? (delivered.has(String(answer.data.message_id)) ? 'delivered to agent/b-ui' : 'not delivered') : 'not sent'}`]);
  const sessionsC = (await events('session.started', T_C)).length;
  const prsC = (await events('pr.published', T_C)).length;
  const prsOpened = s.fake.log.filter((l) => l.method === 'POST' && l.path.endsWith('/pulls')).length;
  const resumedPrompt = mock.log.some((e) => e.kind === 'main' && JSON.stringify(e.summary ?? '').includes('[demo-c]') && JSON.stringify(e.summary).includes('[Resumed]'));
  checks.push([`Killed mid-session: ${T_C} stopped with its edit kept, and resume finished it once`, kept && sessionsC === 2 && prsC === 1 && prsOpened === 3 && resumedPrompt,
    `${sessionsC} sessions (the first, then the resumed one, which was told it was resumed: ${resumedPrompt}); ${prsC} PR for ${T_C}; ${prsOpened} PRs opened on GitHub in all (T-2, T-1, ${T_C})`]);
  for (const [what, ok, evidence] of checks) {
    console.log(`${ok ? '✔' : '✖'} ${what}\n    ${evidence}`);
    if (!ok) failed = true;
  }
  if (KEEP) console.log(`\nKept the stack (schema ${s.db.schema}).`);
  console.log(`\n${failed ? '✖ The pilot rehearsal did not complete.' : '✔ The pilot rehearsal passed.'} (Scripted model and a fake GitHub; the two-Mac run is scripts/pilot/README.md §5.)`);
}

async function until(what: string, pred: () => boolean, ms: number) {
  for (const end = Date.now() + ms; !pred(); await new Promise((r) => setTimeout(r, 100))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
async function untilAsync(what: string, pred: () => Promise<boolean>, ms: number) {
  for (const end = Date.now() + ms; !(await pred()); await new Promise((r) => setTimeout(r, 200))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

let exit = 0;
try {
  await main();
  if (failed) exit = 1;
} catch (e) {
  console.error(`\nrehearsal failed: ${(e as Error).stack ?? (e as Error).message}`);
  exit = 1;
} finally {
  for (const c of cleanups.reverse()) { try { await c(); } catch (e) { console.error(`cleanup: ${(e as Error).message}`); } }
}
process.exit(exit);
