// harnessd v0 end to end (0A item 4): a real coordination server, a real daemon, the real
// `harness approve` CLI and real srt. The daemon and server packages may not import each other,
// so this lives outside both.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Daemon } from '../packages/daemon/src/daemon.ts';
import { parseConfig } from '../packages/daemon/src/config.ts';
import { Approvals } from '../packages/daemon/src/approvals.ts';
import { gitIn, makeRepo, tempDir, tempHome, TOKEN } from '../packages/daemon/test/fixtures.ts';
import { startServer, type RunningServer } from '../packages/server/src/server.ts';
import { TestClient } from '../packages/server/test/client.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from '../packages/server/test/helpers.ts';
import type { EventMessage } from '../packages/protocol/src/index.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let server: RunningServer;
let t: ReturnType<typeof tempDir>;
let project: string;
let watcher: TestClient;
const errors: unknown[] = [];
/** Daemons this file starts: stopped in after(), so a failed assertion fails the test instead of leaving it running. */
const daemons: Daemon[] = [];

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool); // human_test owns it
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_test', 'human_test', 'laptop')");
  for (const id of ['t1', 't2', 't3']) {
    await db.pool.query("INSERT INTO tasks (id, project_id, title, text, scope, owner_human_id) VALUES ($1, $2, $1, $1, '{src/}', 'human_test')", [id, project]);
  }
  server = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: TOKEN, port: 0, offlineAfterMs: 900, onError: (e) => errors.push(e) });
  t = tempDir('e2e');
  watcher = await TestClient.open(server.url);
  watcher.send({ v: 1, type: 'hello', client: { kind: 'cli', version: '0' }, principal: 'human_test', auth: { scheme: 'local-token', token: TOKEN }, subscribe: [{ project_id: project, after_seq: 0 }] });
  await watcher.next('welcome');
});
after(async () => {
  await Promise.all(daemons.map((d) => d.stop().catch(() => {})));
  watcher?.close();
  await server?.close();
  await db?.drop();
  t?.cleanup();
  assert.deepEqual(errors, []);
});

const kinds = (es: EventMessage[]) => es.map((e) => e.kind);
/** The next event about work, skipping presence: under load a late heartbeat can flap device.online/offline in between. */
const nextWork = () => watcher.next('event', (e: EventMessage) => !e.kind.startsWith('device.'));

test('harnessd prepares, sets up, commits and tears down task workspaces, reporting each step', async () => {
  const { repo, sha } = makeRepo(t.dir, {
    'package.json': '{"name":"bench"}\n',
    'harness.yaml': 'setup:\n  command: echo installed > .setup-done\n  manifests: [package.json]\nports:\n  per_agent: 5\n',
    'src/a.ts': 'a\n',
  });
  const home = tempHome(t.dir);
  const config = parseConfig({
    device_id: 'dev_test', principal: 'human_test', server_url: server.url,
    limits: { port_range: [31200, 31299] }, setup: { allowed_domains: [] },
    projects: [{ id: project, repo }],
  }, TOKEN);
  const seen: EventMessage[] = [];
  const daemon = new Daemon({ home, config, heartbeatMs: 200, approvalPollMs: 50, onEvent: (e) => seen.push(e) });
  daemons.push(daemon);
  await daemon.start();
  await daemon.ready();
  assert.equal((await watcher.next('event')).kind, 'device.online');

  // t1: the setup command is new, so it waits for the human, who approves it with the real CLI.
  const preparing = daemon.prepareTask({ projectId: project, taskId: 't1', baseSha: sha, agentId: 'agent_one' });
  assert.deepEqual([(await nextWork()).kind, (await nextWork()).kind], ['worktree.created', 'setup.approval_requested']);
  const [request] = new Approvals(home).pending();
  assert.equal(request!.command, 'echo installed > .setup-done');
  const cli = execFileSync(process.execPath, ['packages/cli/src/main.ts', 'approve', request!.id, '--yes'], { env: { ...process.env, HARNESS_HOME: home.root }, encoding: 'utf8' });
  assert.match(cli, /Approved/);
  const ws1 = await preparing;
  assert.deepEqual([(await nextWork()).kind, (await nextWork()).kind], ['setup.approved', 'setup.ran']);
  assert.equal(fs.readFileSync(path.join(ws1.worktree, '.setup-done'), 'utf8'), 'installed\n', 'setup ran in the worktree');
  assert.equal(ws1.branch, 'harness/task/t1');
  assert.deepEqual(ws1.ports, { base: 31200, count: 5 }, 'the repo lowered ports per agent from 10 to 5');
  assert.equal(ws1.env.PORT, '31200');
  assert.ok(fs.statSync(ws1.configDir).isDirectory());

  // t2: same command and manifests, already approved, so no prompt.
  const ws2 = await daemon.prepareTask({ projectId: project, taskId: 't2', baseSha: sha, agentId: 'agent_two' });
  assert.deepEqual([(await nextWork()).kind, (await nextWork()).kind], ['worktree.created', 'setup.ran']);
  assert.notEqual(ws2.ports.base, ws1.ports.base);

  // t3: two tasks are active, which is the 0A limit (D-38). Refused before any worktree exists.
  await assert.rejects(daemon.prepareTask({ projectId: project, taskId: 't3', baseSha: sha, agentId: 'agent_three' }), /limit is 2/);
  assert.equal(fs.existsSync(daemon.worktreeOf(project, 't3')), false);
  // A project not in the local config is refused outright (deny by default).
  await assert.rejects(daemon.prepareTask({ projectId: 'prj_elsewhere', taskId: 't9', baseSha: sha, agentId: 'agent_x' }), /not in/);

  // Done: harnessd commits the agent's work (D-50). Teardown keeps the unmerged branch.
  fs.writeFileSync(path.join(ws1.worktree, 'src', 'a.ts'), 'agent work\n');
  const commit = await daemon.finishTask({ projectId: project, taskId: 't1', agent: { id: 'agent_one', name: 'agent/one' }, summary: 'Finish t1' });
  assert.equal(gitIn(repo, 'log', '-1', '--format=%an|%s', commit!), 'agent/one|Finish t1');
  assert.deepEqual(await daemon.teardownTask({ projectId: project, taskId: 't1' }, { force: true }), { branchDeleted: false });
  assert.equal((await nextWork()).kind, 'worktree.removed');
  assert.equal(fs.existsSync(ws1.worktree), false);
  assert.deepEqual(Object.keys(daemon.ports.list()), ['t2']);

  // Stopping the daemon: its heartbeats stop and the server marks the device offline.
  await daemon.stop();
  const offline = await watcher.next('event', () => true, 5000);
  assert.deepEqual([offline.kind, offline.actor.device_id], ['device.offline', 'dev_test']);

  // A restarted daemon resumes from its saved cursor rather than replaying history.
  const lastSeen = seen.at(-1)!.seq;
  assert.ok(kinds(seen).includes('setup.ran'));
  const again: EventMessage[] = [];
  const restarted = new Daemon({ home, config, heartbeatMs: 200, onEvent: (e) => again.push(e) });
  daemons.push(restarted);
  await restarted.start();
  await restarted.ready();
  assert.equal((await watcher.next('event', (e) => e.kind === 'device.online')).actor.device_id, 'dev_test');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(again.length > 0 && again.every((e) => e.seq > lastSeen), `replayed old events: ${JSON.stringify(again.map((e) => e.seq))} after ${lastSeen}`);
  await restarted.teardownTask({ projectId: project, taskId: 't2' }, { force: true });
  await restarted.stop();
});
