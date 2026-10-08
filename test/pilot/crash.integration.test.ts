// Crash windows (D-113, acceptance 5): harnessd is a child process, killed with SIGKILL at named points or mid-turn,
// then started again on the same home. Each case ends with no duplicate session, no lost edit, and no busy task
// without a recovery action. The stand-in adapter means no vendor CLI and no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitIn, makeRepo, tempDir, tempHome, TOKEN } from '../../packages/daemon/test/fixtures.ts';
import { startServer } from '../../packages/server/src/server.ts';
import { TestClient } from '../../packages/server/test/client.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from '../../packages/server/test/helpers.ts';
import type { EventMessage } from '../../packages/protocol/src/index.ts';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { execFileSync } from 'node:child_process';

const CHILD = path.resolve(import.meta.dirname, 'harnessd-child.ts');

async function stack(files: Record<string, string> = { 'README.md': 'hi\n' }) {
  const db = await freshSchema();
  const project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_test', 'human_test', 'laptop')");
  const server = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: TOKEN, port: 0 });
  const t = tempDir('crash');
  const { repo } = makeRepo(t.dir, files);
  const home = tempHome(t.dir);
  const raw = { device_id: 'dev_test', principal: 'human_test', server_url: server.url, limits: { port_range: [31800, 31899] }, projects: [{ id: project, repo }] };
  const human = await TestClient.open(server.url);
  human.send({ v: 1, type: 'hello', client: { kind: 'cli', version: '0' }, principal: 'human_test', auth: { scheme: 'local-token', token: TOKEN }, subscribe: [{ project_id: project, after_seq: 0 }] });
  await human.next('welcome');
  const events: EventMessage[] = [];
  human.ws.addEventListener('message', (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === 'event') events.push(m); });
  const command = async (name: string, args: Record<string, unknown>) => {
    const command_id = randomUUID();
    human.send({ v: 1, type: 'command', command_id, project_id: project, name, args });
    const r = await human.next('command_result', (m) => m.command_id === command_id, 10_000);
    if (!r.ok) throw new Error(`${name}: ${r.error.message}`);
    return (r.result ?? {}) as Record<string, string>;
  };
  const until = async (pred: () => boolean, what: string, ms = 20_000) => {
    for (const end = Date.now() + ms; !pred(); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  };
  const children: ChildProcess[] = [];
  /** Starts harnessd on this stack's home; resolves once it's ready (or exits). */
  const harnessd = async (crashAt?: string) => {
    const proc = spawn(process.execPath, [CHILD], { env: { ...process.env, HARNESS_CHILD: JSON.stringify({ home: home.root, raw, token: TOKEN, crashAt }) }, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(proc);
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    proc.stdout!.on('data', (d) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => proc.once('exit', (code, signal) => r({ code, signal })));
    let gone = false;
    void exited.then(() => { gone = true; });
    await until(() => gone || lines.some((l) => l.ready), 'harnessd to be ready or exit');
    return { proc, lines, exited, logged: (re: RegExp) => lines.some((l) => typeof l.log === 'string' && re.test(l.log)) };
  };
  const stop = async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); await new Promise((r) => c.once('exit', r)); }
    human.close();
    await server.close();
    await db.drop();
    t.cleanup();
  };
  const assign = async (name: string) => {
    const agent = (await command('agent.create', { name, vendor: 'claude' })).agent_id!;
    const task = (await command('task.create', { title: name, text: `do ${name}`, scope: [], assignee_agent_id: agent })).task_id!;
    return { agent, task, worktree: path.join(home.worktrees, project, task) };
  };
  const journal = (task: string) => {
    const root = path.join(home.root, 'journal');
    const epoch = fs.readdirSync(root)[0]!;
    return fs.readFileSync(path.join(root, epoch, project, `${task}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l).state as string);
  };
  return { project, events, command, until, harnessd, stop, assign, journal, home };
}
const of = (events: EventMessage[], kind: string, task: string) => events.filter((e) => e.kind === kind && (e.data as { task_id?: string }).task_id === task);

test('killed right after receiving an assignment: the next start does what was asked, once', async () => {
  const s = await stack();
  try {
    const first = await s.harnessd('after_assignment_receipt');
    const t = await s.assign('agent/a');
    assert.equal((await first.exited).signal, 'SIGKILL');
    assert.ok(!fs.existsSync(t.worktree), 'it died before the worktree');
    assert.deepEqual(s.journal(t.task), ['received'], 'but the receipt was durable');
    await s.harnessd();
    await s.until(() => of(s.events, 'session.started', t.task).length === 1, 'the session');
    assert.ok(fs.existsSync(t.worktree));
    assert.deepEqual(s.journal(t.task).filter((x) => x !== 'received'), ['worktree', 'session']);
  } finally { await s.stop(); }
});

test('killed mid-turn: the session is reported ended, the edits stay, and the task is stopped, not restarted', async () => {
  const s = await stack();
  try {
    const first = await s.harnessd();
    const t = await s.assign('agent/b');
    await s.until(() => of(s.events, 'session.started', t.task).length === 1, 'the session');
    const session = (of(s.events, 'session.started', t.task)[0]!.data as { session_id: string }).session_id;
    fs.writeFileSync(path.join(t.worktree, 'work.txt'), 'half done\n'); // the agent's edit, uncommitted
    first.proc.kill('SIGKILL');
    await first.exited;
    const second = await s.harnessd();
    await s.until(() => s.events.some((e) => e.kind === 'session.ended' && (e.data as { session_id: string }).session_id === session), 'the old session to be reported ended');
    const ended = s.events.find((e) => e.kind === 'session.ended' && (e.data as { session_id: string }).session_id === session)!;
    assert.equal((ended.data as { reason: string }).reason, 'harnessd_restarted');
    await s.until(() => second.logged(/its session was interrupted/), 'recovery to stop the task');
    assert.equal(of(s.events, 'session.started', t.task).length, 1, 'no second session: an interrupted task waits for its human');
    assert.equal(fs.readFileSync(path.join(t.worktree, 'work.txt'), 'utf8'), 'half done\n', 'the edit is preserved');
    assert.equal(s.journal(t.task).at(-1), 'stopped');
  } finally { await s.stop(); }
});

test('killed after report_done, before the commit: the next start commits the work', async () => {
  const s = await stack();
  try {
    const first = await s.harnessd('after_report_done');
    const t = await s.assign('agent/c');
    await s.until(() => of(s.events, 'session.started', t.task).length === 1, 'the session');
    fs.writeFileSync(path.join(t.worktree, 'done.txt'), 'finished\n');
    await s.command('task.complete', { task_id: t.task, summary: 'did c' });
    assert.equal((await first.exited).signal, 'SIGKILL');
    assert.equal(of(s.events, 'worktree.committed', t.task).length, 0);
    await s.harnessd();
    await s.until(() => of(s.events, 'worktree.committed', t.task).length === 1, 'the commit');
    const commit = (of(s.events, 'worktree.committed', t.task)[0]!.data as { commit: string }).commit;
    assert.match(gitIn(t.worktree, 'show', '--stat', '--format=%s', commit), /did c[\s\S]*done\.txt/);
    assert.ok(s.journal(t.task).includes('committed'));
  } finally { await s.stop(); }
});

test('one harnessd per home: a second one exits (75) and never touches the first one\'s agents', async () => {
  const s = await stack();
  try {
    const first = await s.harnessd();
    const t = await s.assign('agent/d');
    await s.until(() => of(s.events, 'session.started', t.task).length === 1, 'the session');
    const second = await s.harnessd();
    assert.equal((await second.exited).code, 75);
    assert.ok(second.lines.some((l) => typeof l.locked === 'string'));
    assert.equal(first.proc.exitCode, null, 'the first is still running');
    assert.equal(s.events.filter((e) => e.kind === 'session.ended').length, 0, 'and its agent still runs');
  } finally { await s.stop(); }
});

const SETUP_FILES = {
  'README.md': 'hi\n', 'package.json': '{}\n',
  'slow-setup.mjs': "import fs from 'node:fs'; fs.appendFileSync('setup-runs.txt', 'run\\n'); setTimeout(() => {}, 60_000);\n",
  'harness.yaml': 'setup:\n  command: node slow-setup.mjs\n  manifests: [package.json]\n',
};
const setupPids = () => { try { return execFileSync('pgrep', ['-f', 'slow-setup.mjs'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('killed while a setup approval is pending: the next start stops the task for its human; nothing runs, nothing is lost', async () => {
  const s = await stack(SETUP_FILES);
  try {
    const first = await s.harnessd('during_approval');
    const t = await s.assign('agent/e');
    assert.equal((await first.exited).signal, 'SIGKILL');
    assert.equal(new Approvals(s.home).pending().length, 1, 'the request survived');
    const second = await s.harnessd();
    await s.until(() => second.logged(/its session was interrupted/), 'recovery to stop the task');
    assert.equal(of(s.events, 'session.started', t.task).length, 0, 'no session started without its setup');
    assert.ok(fs.existsSync(t.worktree), 'the worktree stays, for the resume');
    assert.ok(!fs.existsSync(path.join(t.worktree, 'setup-runs.txt')), 'setup never ran unapproved');
    assert.equal(s.journal(t.task).at(-1), 'stopped');
  } finally { await s.stop(); }
});

test('killed while setup runs: the next start kills the setup it left running, and stops the task for its human', async () => {
  const s = await stack(SETUP_FILES);
  try {
    const first = await s.harnessd();
    const t = await s.assign('agent/f');
    await s.until(() => new Approvals(s.home).pending().length === 1, 'the setup request');
    new Approvals(s.home).approve(new Approvals(s.home).pending()[0]!.id);
    await s.until(() => setupPids().length > 0 && fs.existsSync(path.join(s.home.root, 'procs')) && fs.readdirSync(path.join(s.home.root, 'procs')).length === 1, 'setup to run, recorded');
    const orphans = setupPids();
    first.proc.kill('SIGKILL');
    await first.exited;
    assert.ok(orphans.some(alive), 'a kill of harnessd leaves its detached setup running');
    const second = await s.harnessd();
    assert.ok(second.logged(/killed the process group \d+ a crash left running/), 'the next start killed it');
    await s.until(() => orphans.every((p) => !alive(p)), 'the orphaned setup to be gone');
    assert.equal(fs.readdirSync(path.join(s.home.root, 'procs')).length, 0);
    await s.until(() => second.logged(/its session was interrupted/), 'recovery to stop the task');
    assert.ok(s.journal(t.task).includes('setup_started') && !s.journal(t.task).includes('setup_ok'));
    assert.equal(of(s.events, 'session.started', t.task).length, 0);
  } finally { await s.stop(); }
});

test('killed as the session ended, before its result was saved: reported ended once, and the work committed once', async () => {
  const s = await stack();
  try {
    const first = await s.harnessd('before_result_persist');
    const t = await s.assign('agent/g');
    await s.until(() => of(s.events, 'session.started', t.task).length === 1, 'the session');
    const session = (of(s.events, 'session.started', t.task)[0]!.data as { session_id: string }).session_id;
    fs.writeFileSync(path.join(t.worktree, 'result.txt'), 'the result\n');
    await s.command('task.complete', { task_id: t.task, summary: 'did g' });
    assert.equal((await first.exited).signal, 'SIGKILL');
    await s.harnessd();
    await s.until(() => of(s.events, 'worktree.committed', t.task).length === 1, 'the commit');
    await s.until(() => s.events.some((e) => e.kind === 'session.ended' && (e.data as { session_id: string }).session_id === session), 'the session reported ended');
    await new Promise((r) => setTimeout(r, 600)); // a few heartbeats: nothing is reported twice
    assert.equal(s.events.filter((e) => e.kind === 'session.ended' && (e.data as { session_id: string }).session_id === session).length, 1);
    assert.equal(of(s.events, 'worktree.committed', t.task).length, 1);
    assert.equal(of(s.events, 'session.started', t.task).length, 1, 'no second session');
  } finally { await s.stop(); }
});
