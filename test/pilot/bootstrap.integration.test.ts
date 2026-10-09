// Acceptance 1, join without SQL (PB1; D-111): two Macs, each with its own human, device key and home, join one
// project. The operator applies a pilot file (twice: the second changes nothing). Each human runs the real
// `harness setup keygen` and `harness setup`, pinning only what they were told aloud. Two harnessds then connect with
// distinct identities, and `harness doctor` passes on a good config and names what's wrong on a broken one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { Daemon } from '../../packages/daemon/src/daemon.ts';
import { loadConfig } from '../../packages/daemon/src/config.ts';
import { harnessHome } from '../../packages/daemon/src/home.ts';
import { makeRepo, tempDir } from '../../packages/daemon/test/fixtures.ts';
import { doctor } from '../../packages/cli/src/doctor.ts';
import { applyPilot, ensureServerKey, parsePilot } from '../../packages/server/src/admin.ts';
import { parsePrivateKey, taskSha256 } from '../../packages/protocol/src/signing.ts';
import { startServer } from '../../packages/server/src/server.ts';
import { freshSchema, TEST_DATABASE_URL } from '../../packages/server/test/helpers.ts';

const CLI = path.resolve(import.meta.dirname, '../../packages/cli/src/main.ts');
const freePort = () => new Promise<number>((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address() as net.AddressInfo; srv.close(() => resolve(port)); });
});
const until = async (pred: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  for (const end = Date.now() + ms; !(await pred()); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};
/** The real CLI, as that Mac's human, in that Mac's home. */
const harness = (home: string, ...args: string[]) =>
  promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, HARNESS_HOME: home } }).then((r) => r.stdout);
const said = (out: string, label: string) => new RegExp(`${label} = "(ed25519:[^"]+)"`).exec(out)![1]!;

/** A stand-in for harnessd's socket (PA3c signs for real): records each request and answers with `reply`. */
async function fakeHarnessd(home: string, reply: (req: { id: unknown; method: string; params: Record<string, unknown> }) => unknown) {
  const run = path.join(home, 'run');
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(run, 'uirpc.token'), 'tok\n', { mode: 0o600 });
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  const server = net.createServer((c) => {
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as { id: unknown; token: string; method: string; params: Record<string, unknown> };
      assert.equal(req.token, 'tok');
      seen.push({ method: req.method, params: req.params });
      c.write(`${JSON.stringify({ id: req.id, ...(reply(req) as object) })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(path.join(run, 'harnessd.sock'), r));
  return { seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('two Macs join one project with no SQL: apply twice, setup on each, two identities connect, doctor checks', async () => {
  const t = tempDir('bootstrap');
  const db = await freshSchema();
  const daemons: Daemon[] = [];
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    const port = await freePort();
    // The operator's coordinator key, and each human's own device key, made on their own Mac.
    const serverKeyFile = path.join(t.dir, 'coordinator', 'server.key');
    const coordinator = ensureServerKey(serverKeyFile);
    const macs = ['a', 'b'].map((x) => ({ x, home: path.join(t.dir, `home-${x}`), human: `human_${x}`, device: `dev_${x}`, repo: makeRepo(path.join(t.dir, `mac-${x}`), { 'README.md': `${x}\n` }).repo }));
    const keys: Record<string, string> = {};
    for (const m of macs) {
      const out = await harness(m.home, 'setup', 'keygen', '--device', m.device);
      keys[m.device] = said(out, 'public_key');
      assert.match(out, /fingerprint SHA256:/);
      await assert.rejects(harness(m.home, 'setup', 'keygen'), /already exists; a device keeps its key/);
    }

    // The operator applies the pilot file: no hand-written SQL. The second apply changes nothing.
    const spec = parsePilot({
      humans: macs.map((m) => ({ id: m.human, display_name: m.x.toUpperCase() })),
      devices: macs.map((m) => ({ id: m.device, human: m.human, name: `${m.x}'s Mac`, public_key: keys[m.device] })),
      projects: [{ id: 'prj_pilot', name: 'pilot' }],
      memberships: macs.map((m) => ({ project: 'prj_pilot', human: m.human, role: 'owner' })),
      agents: macs.map((m) => ({ project: 'prj_pilot', name: `agent/${m.x}-ui`, human: m.human, device: m.device })),
    });
    assert.equal((await applyPilot(db.pool, spec)).changes.length, 9);
    assert.deepEqual((await applyPilot(db.pool, spec)).changes, []);
    server = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, serverKey: parsePrivateKey(fs.readFileSync(serverKeyFile, 'utf8')), port });

    // Each human writes their config with the real CLI, pinning the coordinator and the other Mac, as read aloud.
    for (const m of macs) {
      const other = macs.find((o) => o !== m)!;
      const out = await harness(m.home, 'setup', '--device', m.device, '--principal', m.human, '--server-url', `ws://127.0.0.1:${port}`,
        '--server-key', coordinator.publicKey, '--trust-device', `${other.device}=${other.human}:${keys[other.device]}`,
        '--project', 'prj_pilot', '--repo', m.repo, '--integration', 'local');
      assert.match(out, /wrote .*config\.toml/);
      const config = loadConfig(harnessHome(m.home));
      assert.deepEqual([config.auth, config.limits.maxConcurrentAgents, config.agents.maxBudgetUsd, config.agents.dailyBudgetUsd, config.ui.port], ['device-key', 1, 0.1, 0.25, 7480]);
      assert.deepEqual(Object.keys(config.trustedDevices).sort(), ['dev_a', 'dev_b']);
      await assert.rejects(harness(m.home, 'setup', '--device', m.device, '--principal', m.human, '--server-key', coordinator.publicKey, '--project', 'prj_pilot', '--repo', m.repo, '--integration', 'local'), /exists; re-run with --force/);
    }

    // Two harnessds, two identities: each proves its own device's key, and each device's presence is its own.
    for (const m of macs) {
      const home = harnessHome(m.home);
      const d = new Daemon({ home, config: loadConfig(home), heartbeatMs: 200 });
      daemons.push(d);
      await d.start();
      await d.ready();
      assert.equal(d.linkState, 'connected');
    }
    await until(async () => (await db.pool.query("SELECT count(*)::int AS n FROM devices WHERE id IN ('dev_a', 'dev_b') AND last_heartbeat_at IS NOT NULL")).rows[0].n === 2, 'both devices\' heartbeats');

    // doctor on a good config: the identity, the coordinator, the membership and the clock check out.
    const ok = Object.fromEntries((await doctor(harnessHome(macs[0]!.home))).map((c) => [c.name, c]));
    for (const name of ['config', 'device key', 'coordinator', 'clock', 'project prj_pilot', 'budgets', 'repo prj_pilot']) assert.equal(ok[name]?.ok, true, `${name}: ${ok[name]?.detail}`);
    // A broken one: the coordinator's pin is wrong. doctor names the mismatch and never trusts the answer.
    const broken = harnessHome(macs[1]!.home);
    const text = fs.readFileSync(broken.config, 'utf8').replace(coordinator.publicKey, keys.dev_a!);
    fs.writeFileSync(broken.config, text, { mode: 0o600 });
    const bad = Object.fromEntries((await doctor(broken)).map((c) => [c.name, c]));
    assert.equal(bad.coordinator?.ok, false);
    assert.match(bad.coordinator!.detail, /server_identity_mismatch/);
    // And a device key that isn't the one pinned for this device.
    fs.writeFileSync(broken.config, text.replace(keys.dev_b!, keys.dev_a!), { mode: 0o600 });
    const pin = Object.fromEntries((await doctor(broken, { offline: true })).map((c) => [c.name, c]));
    // Refused by config.toml's own checks (two devices with one key), or caught by doctor's comparison.
    assert.match(pin['device key']?.ok === false ? pin['device key'].detail : pin.config!.detail, /same key|isn't the key pinned/);
  } finally {
    for (const d of daemons) await d.stop();
    await server?.close();
    await db.drop();
    t.cleanup();
  }
});

test('with device keys the CLI never signs itself: harnessd is asked to sign each lifecycle command, for the task as the server stored it', async () => {
  const t = tempDir('cli-dispatch');
  const home = fs.mkdtempSync('/tmp/hb-'); // a short path: macOS caps Unix socket paths at 104 bytes
  const db = await freshSchema();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let fake: Awaited<ReturnType<typeof fakeHarnessd>> | null = null;
  try {
    const port = await freePort();
    const coordinator = ensureServerKey(path.join(t.dir, 'server.key'));
    const key = said(await harness(home, 'setup', 'keygen', '--device', 'dev_a'), 'public_key');
    const repo = makeRepo(t.dir, { 'README.md': 'a\n' }).repo;
    await applyPilot(db.pool, parsePilot({
      humans: [{ id: 'human_a', display_name: 'A' }], devices: [{ id: 'dev_a', human: 'human_a', name: 'A', public_key: key }],
      projects: [{ id: 'prj_pilot', name: 'pilot' }], memberships: [{ project: 'prj_pilot', human: 'human_a', role: 'owner' }],
      agents: [{ project: 'prj_pilot', name: 'agent/a-ui', human: 'human_a', device: 'dev_a' }],
    }));
    server = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, serverKey: parsePrivateKey(fs.readFileSync(path.join(t.dir, 'server.key'), 'utf8')), port });
    await harness(home, 'setup', '--device', 'dev_a', '--principal', 'human_a', '--server-url', `ws://127.0.0.1:${port}`, '--server-key', coordinator.publicKey,
      '--project', 'prj_pilot', '--repo', repo, '--integration', 'local');
    const replies: unknown[] = [];
    fake = await fakeHarnessd(home, () => replies.shift() ?? { ok: true, result: { seqs: [], result: null } });

    // task add --assign: the task is created on the server, then harnessd is asked for a signed start of it.
    const out = await harness(home, 'task', 'add', 'Login API', '--scope', 'src/api/**', '--text', 'Build POST /login.', '--assign', 'a-ui');
    const id = /Created (T-\d+)/.exec(out)![1]!;
    assert.match(out, new RegExp(`Signing a start of ${id} "Login API" \\(scope src/api/;`));
    const agent = (await db.pool.query("SELECT id FROM agent_principals WHERE name = 'agent/a-ui'")).rows[0].id;
    assert.deepEqual(fake.seen.map((x) => x.method), ['dispatch']);
    const p = fake.seen[0]!.params;
    assert.deepEqual([p.project_id, p.kind, p.task_id, p.args], ['prj_pilot', 'start', id, { assignee_agent_id: agent }]);
    // The hash is of the task as the server stored it (scope normalized), the same one PB2a checks.
    assert.deepEqual(p.expected, { task_sha256: taskSha256({ title: 'Login API', text: 'Build POST /login.', scope: ['src/api/'], owner_human_id: 'human_a' }) });
    assert.match(String(p.command_id), /^[0-9a-f-]{36}$/);
    assert.equal((await db.pool.query('SELECT assignee_agent_id FROM tasks WHERE id = $1', [id])).rows[0].assignee_agent_id, null, 'the CLI sent no unsigned assignment');

    // resume, abandon: each its own kind and args. A conflict says the task changed, and nothing is retried.
    await harness(home, 'task', 'resume', id, '--text', 'carry on');
    replies.push({ ok: false, error: { code: 'conflict', message: `${id} changed` } });
    await assert.rejects(harness(home, 'task', 'abandon', id, '--reason', 'not now'), /it changed since you looked/);
    assert.deepEqual(fake.seen.slice(1).map((x) => [x.params.kind, x.params.args]), [['resume', { text: 'carry on' }], ['abandon', { reason: 'not now' }]]);
  } finally {
    await fake?.close();
    await server?.close();
    await db.drop();
    fs.rmSync(home, { recursive: true, force: true });
    t.cleanup();
  }
});
