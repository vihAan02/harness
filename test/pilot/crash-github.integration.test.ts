// Crash windows in GitHub mode (D-113, D-114, D-115; acceptance 5): harnessd, as a child process on side A of the pilot
// stack, is killed with SIGKILL during a push and right after a merge request is armed, then started again on the same
// home. Each ends with one push, one PR, one merge and one landed event: nothing twice, nothing lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { startPilotStack, type PilotStack } from '../support.ts';

const CHILD = path.resolve(import.meta.dirname, 'harnessd-child.ts');

/** Side A's harnessd as a child on its own home; resolves once it's ready, or has exited. */
async function harnessd(s: PilotStack, children: ChildProcess[], crashAt?: string) {
  const proc = spawn(process.execPath, [CHILD], {
    env: { ...process.env, HARNESS_CHILD: JSON.stringify({ home: s.a.home.root, raw: s.a.raw, token: '', crashAt, pilot: { githubToken: s.fake.token, retryMs: 100 } }) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(proc);
  const lines: Record<string, unknown>[] = [];
  let buf = '';
  proc.stdout!.on('data', (d) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => proc.once('exit', (code, signal) => r({ code, signal })));
  let gone = false;
  void exited.then(() => { gone = true; });
  await s.until(() => gone || lines.some((l) => l.ready), 30_000, 'harnessd to be ready or exit');
  return { proc, lines, exited };
}
const count = async (s: PilotStack, kind: string, task: string) =>
  (await s.db.pool.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND kind = $2 AND data->>'task_id' = $3", [s.project, kind, task])).rows[0].n as number;
const waitFor = async (s: PilotStack, what: string, pred: () => Promise<boolean>, ms = 30_000) => {
  for (const end = Date.now() + ms; !(await pred()); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};
const merges = (s: PilotStack) => s.fake.log.filter((l) => l.method === 'PUT' && l.path.endsWith('/merge')).length;

/** A task for side A's agent, done with one changed file; resolves once harnessd asks to publish it. */
async function done(s: PilotStack, name: string) {
  const agent = (await s.a.command('agent.create', { name, vendor: 'claude' })).agent_id!;
  const task = await s.a.assign(agent, { title: `${name} work`, text: `do ${name}`, scope: [] });
  await waitFor(s, 'the session', async () => (await count(s, 'session.started', task)) === 1);
  fs.writeFileSync(path.join(s.a.home.worktrees, s.project, task, `${name.replace('/', '-')}.txt`), 'work\n');
  await s.a.signed('task.complete', { task_id: task });
  await waitFor(s, 'the publish request', async () => new Approvals(s.a.home).pending().some((r) => r.kind === 'publish' && r.taskId === task));
  return task;
}

test('killed during the push: the next start pushes and opens the PR, once', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, daemons: false });
  const children: ChildProcess[] = [];
  try {
    const first = await harnessd(s, children, 'during_push');
    const task = await done(s, 'agent/push');
    new Approvals(s.a.home).approve(new Approvals(s.a.home).pending().find((r) => r.taskId === task)!.id);
    assert.equal((await first.exited).signal, 'SIGKILL');
    assert.equal(s.fake.prs().length, 0, 'killed before the push');
    await harnessd(s, children);
    await waitFor(s, 'the PR', async () => (await count(s, 'pr.published', task)) === 1);
    await new Promise((r) => setTimeout(r, 600)); // several poll rounds: nothing more happens
    assert.equal(s.fake.prs().length, 1);
    assert.equal(await count(s, 'pr.published', task), 1);
    assert.equal(s.fake.log.filter((l) => l.method === 'POST' && l.path.endsWith('/pulls')).length, 1);
  } finally {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); await new Promise((r) => c.once('exit', r)); }
    await s.stop();
  }
});

test('killed right after the merge request was armed: the next start reconciles from GitHub, and merges and lands once', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, daemons: false });
  const children: ChildProcess[] = [];
  try {
    const first = await harnessd(s, children);
    const task = await done(s, 'agent/merge');
    new Approvals(s.a.home).approve(new Approvals(s.a.home).pending().find((r) => r.taskId === task)!.id);
    await waitFor(s, 'the PR', async () => (await count(s, 'pr.published', task)) === 1);
    first.proc.kill('SIGTERM');
    await first.exited;
    const second = await harnessd(s, children, 'after_merge_request');
    const pr = (await s.db.pool.query('SELECT pr_number, head_sha, base_sha FROM task_prs WHERE task_id = $1', [task])).rows[0];
    await s.a.integrate(task, { pr_number: pr.pr_number, head_sha: pr.head_sha, base_sha: pr.base_sha });
    assert.equal((await second.exited).signal, 'SIGKILL');
    assert.equal(merges(s), 0, 'armed, then killed before asking GitHub');
    await harnessd(s, children);
    await waitFor(s, 'the land', async () => (await count(s, 'land.completed', task)) === 1, 60_000);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(merges(s), 1, 'merged once');
    assert.equal(await count(s, 'land.completed', task), 1, 'landed once');
    assert.equal(s.fake.prs()[0]!.merged, true);
  } finally {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) { c.kill('SIGTERM'); await new Promise((r) => c.once('exit', r)); }
    await s.stop();
  }
});
