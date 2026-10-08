// D-119 in harnessd (TH-22): with device keys (the pilot), no agent starts while a loopback Postgres accepts a
// password-less login, because the session's sandbox may connect to localhost:* (F-58) and such a Postgres runs
// programs outside it. Local-token stacks (tests, demos, 0B) are unchanged. No coordination server: reports are
// recorded instead of sent, and a stand-in adapter plays the agent. The check is injected, except in the last
// test, which runs the real one against this machine's Postgres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Daemon, type DaemonOptions } from '../../packages/daemon/src/daemon.ts';
import { parseConfig } from '../../packages/daemon/src/config.ts';
import type { ServerLink } from '../../packages/daemon/src/link.ts';
import { findTrustPostgres, trustRefusal, type TrustLogin } from '../../packages/daemon/src/localsvc.ts';
import { makeRepo, tempDir, tempHome, TOKEN } from '../../packages/daemon/test/fixtures.ts';
import { generateKeyPair } from '../../packages/protocol/src/signing.ts';
import type { EventMessage } from '../../packages/protocol/src/index.ts';
import { FakeAdapter } from '../fake-adapter.ts';

const PROJECT = 'prj_local';
const AGENT = { id: 'agent_pilot', name: 'agent/pilot', vendor: 'claude' };
const HIT: TrustLogin[] = [{ port: 5433, user: 'me' }];
const REFUSAL = /^D-119: a loopback Postgres on port 5433 accepts password-less logins, so a sandboxed agent could run programs outside its sandbox\. Require passwords on its host lines \(scripts\/pilot\/pg-harden\.sh\) or stop it; harnessd won't start agents until then\.$/;
const task = (id: string) => ({ id, title: id, text: `do ${id}`, scope: [], ownerHumanId: 'human_test' });

/** harnessd with no server: what it would report is recorded instead. */
class Offline extends Daemon {
  reports: string[] = [];
  override async report(_projectId: string, name: string): Promise<void> { this.reports.push(name); }
}

/** A device in `auth` mode; `check` stands in for the real D-119 check and counts its calls. */
function device(auth: 'device-key' | 'local-token', check?: () => Promise<TrustLogin[]>) {
  const t = tempDir('localhost');
  const { repo, sha } = makeRepo(t.dir, { 'README.md': 'hi\n' });
  const home = tempHome(t.dir);
  for (const d of [home.sessions, home.logs]) fs.mkdirSync(d, { recursive: true });
  const base = { device_id: 'dev_test', principal: 'human_test', server_url: 'ws://127.0.0.1:9', limits: { port_range: [32200, 32299] }, projects: [{ id: PROJECT, repo }] };
  const config = auth === 'device-key'
    ? parseConfig({
      ...base, auth, server_key: generateKeyPair().publicKey, trust: { devices: { dev_test: { human: 'human_test', key: generateKeyPair().publicKey } } },
      agents: { max_budget_usd: 0.1, daily_budget_usd: 0.25 },
    }, '', { env: {} })
    : parseConfig(base, TOKEN);
  const adapter = new FakeAdapter();
  const logs: string[] = [];
  const calls = { n: 0 };
  const opts: DaemonOptions = {
    home, config, adapters: { claude: adapter }, diffIntervalMs: 600_000, log: (m) => logs.push(m),
    provider: { name: null, auth: { mode: 'api-key', apiKey: 'unused' }, model: null },
    ...(check ? { localServices: { check: () => { calls.n++; return check(); } } } : {}),
  };
  const daemon = new Offline(opts);
  const start = async (taskId: string) => daemon.startAgent(await daemon.prepareTask({ projectId: PROJECT, taskId, baseSha: sha, agentId: AGENT.id }), AGENT, task(taskId));
  const done = async () => { await daemon.stop(); t.cleanup(); };
  return { daemon, adapter, logs, calls, sha, start, done };
}

const until = async (pred: () => boolean, what: string, ms = 5000) => {
  for (const end = Date.now() + ms; !pred(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

test('device keys: an agent start is refused while a loopback Postgres takes a password-less login, and nothing starts', async () => {
  let hits = HIT;
  const d = device('device-key', async () => hits);
  try {
    const ws = await d.daemon.prepareTask({ projectId: PROJECT, taskId: 't1', baseSha: d.sha, agentId: AGENT.id });
    d.daemon.reports.length = 0;
    await assert.rejects(d.daemon.startAgent(ws, AGENT, task('t1')), { message: REFUSAL });
    assert.equal(d.adapter.sessions.length, 0, 'no session started');
    assert.equal(d.daemon.running.size, 0);
    assert.deepEqual(d.daemon.sessions.list(), [], 'no session recorded');
    assert.equal(d.daemon.reports.length, 0, 'nothing reported');
    // The human fixes pg_hba: a hit is never cached, so the next start checks again, and the session starts.
    hits = [];
    await d.daemon.startAgent(ws, AGENT, task('t1'));
    assert.equal(d.adapter.sessions.length, 1);
    assert.ok(d.daemon.running.has('t1'));
    assert.ok(d.daemon.reports.includes('session.report'));
    assert.equal(d.calls.n, 2);
    // A clean result holds for 60 s: the next start doesn't probe again.
    await d.start('t2');
    assert.equal(d.adapter.sessions.length, 2);
    assert.equal(d.calls.n, 2);
  } finally {
    await d.done();
  }
});

test('device keys: task.assigned is refused before a worktree, setup or ports exist', async () => {
  const d = device('device-key', async () => HIT);
  try {
    const view = d.daemon.view(PROJECT);
    let seq = 0;
    const event = (kind: string, data: Record<string, unknown>) => ({
      v: 1, type: 'event', project_id: PROJECT, seq: ++seq, at: new Date().toISOString(), actor: { principal: 'human_test', on_behalf_of: null, device_id: null }, kind, data,
    }) as unknown as EventMessage;
    view.apply(event('agent.created', { agent_id: AGENT.id, name: AGENT.name, vendor: 'claude', accountable_human_id: 'human_test' }));
    view.apply(event('task.created', { task_id: 't9', title: 't9', text: 'do t9', scope: [], owner_human_id: 'human_test' }));
    const assigned = event('task.assigned', { task_id: 't9', assignee_agent_id: AGENT.id });
    view.apply(assigned);
    await assert.rejects(d.daemon.lifecycle(assigned), { message: REFUSAL });
    assert.equal(fs.existsSync(d.daemon.worktreeOf(PROJECT, 't9')), false, 'no worktree');
    assert.deepEqual(d.daemon.ports.list(), {}, 'no ports');
    assert.equal(d.daemon.reports.length, 0);
    assert.equal(d.adapter.sessions.length, 0);
  } finally {
    await d.done();
  }
});

test('device keys: ready() logs the verdict without waiting for it; a check that fails refuses agents (fail closed)', async () => {
  let release!: (h: TrustLogin[]) => void;
  const d = device('device-key', () => new Promise((r) => { release = r; }));
  // ready() needs only a link that is ready and caught up (no project modes: all local); the D-119 check doesn't hold it up.
  d.daemon.link = { whenReady: async () => {}, whenCaughtUp: async () => {}, stop: async () => {}, modes: {} } as unknown as ServerLink;
  try {
    await d.daemon.ready();
    assert.equal(d.calls.n, 1, 'the check started at ready');
    release(HIT);
    await until(() => d.logs.some((l) => REFUSAL.test(l)), 'the D-119 verdict in the log');
    const failing = device('device-key', async () => { throw new Error('lsof exploded'); });
    try {
      await assert.rejects(failing.start('t1'), { message: /^D-119: couldn't check loopback Postgres for password-less logins \(lsof exploded\); harnessd won't start agents until it can$/ });
      assert.equal(failing.adapter.sessions.length, 0);
    } finally {
      await failing.done();
    }
  } finally {
    await d.done();
  }
});

test('device keys: HARNESS_ALLOW_TRUST_PG=1 is the human\'s override; the check never runs and the log says so', async () => {
  const d = device('device-key', async () => HIT);
  process.env.HARNESS_ALLOW_TRUST_PG = '1';
  try {
    await d.start('t1');
    assert.equal(d.adapter.sessions.length, 1);
    d.daemon.logTrustPostgres();
    assert.ok(d.logs.some((l) => /^D-119: HARNESS_ALLOW_TRUST_PG=1, so agents start/.test(l)), d.logs.join(' | '));
    assert.equal(d.calls.n, 0);
  } finally {
    delete process.env.HARNESS_ALLOW_TRUST_PG;
    await d.done();
  }
});

test('local-token stacks are unchanged: no check runs and nothing is logged', async () => {
  const d = device('local-token', async () => HIT);
  try {
    await d.start('t1');
    assert.equal(d.adapter.sessions.length, 1);
    d.daemon.logTrustPostgres();
    assert.equal(d.calls.n, 0);
    assert.deepEqual(d.logs.filter((l) => l.includes('D-119')), []);
  } finally {
    await d.done();
  }
});

test('this machine: the real check, and harnessd refuses agents if it finds a password-less loopback Postgres', async (t) => {
  const t0 = Date.now();
  const hits = await findTrustPostgres();
  t.diagnostic(`findTrustPostgres: ${JSON.stringify(hits)} in ${Date.now() - t0} ms`);
  if (!hits.length) return t.skip('no loopback Postgres here accepts a password-less login');
  const d = device('device-key'); // the real check, as harnessd runs it
  try {
    await assert.rejects(d.start('t1'), (e: Error) => { assert.equal(e.message, trustRefusal(hits)); return true; });
    assert.equal(d.adapter.sessions.length, 0);
  } finally {
    await d.done();
  }
});
