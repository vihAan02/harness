// Pilot provisioning (PB1; D-111, acceptance 1): two humans, one device each, one project and device-bound agents,
// from one file, with no hand-written SQL. Applying it twice changes nothing; a key changes only with a rotate; a
// device or an agent never changes hands; the file is checked strictly before anything is written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, fingerprint } from '@harness/protocol/signing';
import { applyPilot, ensureServerKey, parsePilot } from '../src/admin.ts';
import { freshSchema } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
const keyA = generateKeyPair().publicKey;
const keyB = generateKeyPair().publicKey;

const raw = () => ({
  humans: [{ id: 'human_a', display_name: 'A', github_login: 'a-login' }, { id: 'human_b', display_name: 'B' }],
  devices: [{ id: 'dev_a', human: 'human_a', name: 'A\'s Mac', public_key: keyA }, { id: 'dev_b', human: 'human_b', name: 'B\'s Mac', public_key: keyB }],
  projects: [{ id: 'prj_pilot', name: 'pilot', repo_url: 'https://github.com/o/r.git' }],
  memberships: [{ project: 'prj_pilot', human: 'human_a', role: 'owner' }, { project: 'prj_pilot', human: 'human_b', role: 'member' }],
  agents: [{ project: 'prj_pilot', name: 'agent/a-ui', human: 'human_a', device: 'dev_a' }, { project: 'prj_pilot', name: 'agent/b-ui', human: 'human_b', device: 'dev_b' }],
});
const count = async (table: string) => Number((await db.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

before(async () => { db = await freshSchema(); });
after(async () => { await db?.drop(); });

test('parsePilot refuses unknown keys, malformed ids and keys, and every reference that does not resolve', () => {
  const broken = (f: (r: ReturnType<typeof raw>) => void, re: RegExp) => { const r = raw(); f(r); assert.throws(() => parsePilot(r), re); };
  broken((r) => { (r as Record<string, unknown>).tokens = []; }, /unknown key tokens/);
  broken((r) => { (r.humans[0] as Record<string, unknown>).password = 'x'; }, /humans\[0\]: unknown key password/);
  broken((r) => { r.devices[0]!.id = 'dev a'; }, /devices\[0\]\.id must match/);
  broken((r) => { r.devices[0]!.public_key = 'ed25519:not-a-key'; }, /must be an Ed25519 key/);
  broken((r) => { r.devices[1]!.public_key = keyA; }, /dev_a and dev_b have the same key/);
  broken((r) => { r.devices[0]!.human = 'human_x'; }, /isn't in \[\[humans\]\]/);
  broken((r) => { r.memberships[1]!.role = 'admin' as never; }, /role must be one of/);
  broken((r) => { r.agents[1]!.device = 'dev_a'; }, /runs on its own human's device/);
  broken((r) => { r.memberships[1]!.role = 'viewer'; }, /must be an owner or member/);
  broken((r) => { r.agents[0]!.name = 'ui'; }, /must look like agent\//);
  for (const url of ['https://user:tok@github.com/o/r.git', 'http://github.com/o/r.git', 'https://github.com/o/r.git?x=1', 'https://github.com/o/r.git#f', 'not a url']) {
    broken((r) => { r.projects[0]!.repo_url = url; }, /repo_url (must be an https URL with no credentials|is not a URL)/);
  }
});

test('apply creates the pilot\'s rows and logs each agent; a second apply changes nothing', async () => {
  const spec = parsePilot(raw());
  const first = await applyPilot(db.pool, spec);
  assert.deepEqual(first.changes, [
    'human human_a: created', 'human human_b: created', 'device dev_a: created for human_a', 'device dev_b: created for human_b', 'project prj_pilot: created',
    'human_a in prj_pilot: owner', 'human_b in prj_pilot: member', 'agent agent/a-ui in prj_pilot: created on dev_a', 'agent agent/b-ui in prj_pilot: created on dev_b',
  ]);
  assert.deepEqual(first.fingerprints.map((f) => [f.device_id, f.fingerprint]), [['dev_a', fingerprint(keyA)], ['dev_b', fingerprint(keyB)]]);
  const agents = (await db.pool.query('SELECT name, accountable_human_id, device_id FROM agent_principals ORDER BY name')).rows;
  assert.deepEqual(agents, [{ name: 'agent/a-ui', accountable_human_id: 'human_a', device_id: 'dev_a' }, { name: 'agent/b-ui', accountable_human_id: 'human_b', device_id: 'dev_b' }]);
  const created = (await db.pool.query("SELECT actor_principal, data FROM events WHERE project_id = 'prj_pilot' AND kind = 'agent.created' ORDER BY seq")).rows;
  assert.deepEqual(created.map((e) => [e.actor_principal, e.data.name, e.data.device_id]), [['human_a', 'agent/a-ui', 'dev_a'], ['human_b', 'agent/b-ui', 'dev_b']]);
  assert.equal((await db.pool.query("SELECT github_login FROM human_principals WHERE id = 'human_a'")).rows[0].github_login, 'a-login');

  const before = await Promise.all(['human_principals', 'devices', 'projects', 'project_memberships', 'agent_principals', 'events'].map(count));
  const again = await applyPilot(db.pool, parsePilot(raw()));
  assert.deepEqual(again.changes, []);
  assert.deepEqual(await Promise.all(['human_principals', 'devices', 'projects', 'project_memberships', 'agent_principals', 'events'].map(count)), before);
});

test('a device\'s key changes only with --rotate; a revoke sticks; a device or an agent never changes hands', async () => {
  const next = generateKeyPair().publicKey;
  const rotated = raw();
  rotated.devices[0]!.public_key = next;
  await assert.rejects(applyPilot(db.pool, parsePilot(rotated)), /key differs from the registered one .*--rotate dev_a/);
  assert.deepEqual((await applyPilot(db.pool, parsePilot(rotated), { rotate: ['dev_a'] })).changes, ['device dev_a: key rotated']);
  assert.deepEqual((await applyPilot(db.pool, parsePilot(rotated), { revoke: ['dev_b'] })).changes, ['device dev_b: revoked']);
  await assert.rejects(applyPilot(db.pool, parsePilot(rotated), { rotate: ['dev_b'], revoke: ['dev_b'] }), /both rotated and revoked/);
  // No agent goes onto a revoked device.
  const onRevoked = { ...raw(), devices: rotated.devices, agents: [{ project: 'prj_pilot', name: 'agent/b-two', human: 'human_b', device: 'dev_b' }] };
  await assert.rejects(applyPilot(db.pool, parsePilot(onRevoked)), /would run on dev_b, which is revoked/);
  assert.ok((await db.pool.query("SELECT revoked_at FROM devices WHERE id = 'dev_b'")).rows[0].revoked_at);
  assert.deepEqual((await applyPilot(db.pool, parsePilot(rotated))).changes, [], 'a later apply leaves the revoke in place');
  const stolen = raw();
  stolen.devices[0]!.public_key = next;
  stolen.devices[0]!.human = 'human_b';
  stolen.agents = [];
  await assert.rejects(applyPilot(db.pool, parsePilot(stolen)), /is human_a's; a device never changes hands/);
  const moved = raw();
  moved.devices[0]!.public_key = next;
  moved.devices.push({ id: 'dev_a2', human: 'human_a', name: 'A\'s other Mac', public_key: generateKeyPair().publicKey });
  moved.agents[0]!.device = 'dev_a2';
  await assert.rejects(applyPilot(db.pool, parsePilot(moved)), /runs on dev_a; it never moves/);
  assert.equal(await count("devices WHERE id = 'dev_a2'"), 0, 'a failed apply writes nothing');
  await assert.rejects(applyPilot(db.pool, parsePilot(raw()), { revoke: ['dev_x'] }), /dev_x isn't in \[\[devices\]\]/);
  // A key already registered under another device id is refused, not shared.
  const copied = { ...raw(), devices: [...rotated.devices, { id: 'dev_c', human: 'human_b', name: 'C', public_key: next }], agents: [] };
  copied.devices = copied.devices.filter((d) => d.id !== 'dev_a');
  await assert.rejects(applyPilot(db.pool, parsePilot(copied)), /dev_c's key is already registered for dev_a/);
  // Rotating a revoked device clears its revocation, and says so.
  const fresh = generateKeyPair().publicKey;
  const back = { ...raw(), devices: rotated.devices.map((d) => (d.id === 'dev_b' ? { ...d, public_key: fresh } : d)) };
  assert.deepEqual((await applyPilot(db.pool, parsePilot(back), { rotate: ['dev_b'] })).changes, ['device dev_b: key rotated; its revocation is cleared']);
});

test('integration_mode = "github" is refused until the coordinator has migration 0016', async () => {
  const r = { ...raw(), devices: [], agents: [] }; // independent of the keys the test above rotated
  (r.projects[0] as Record<string, unknown>).integration_mode = 'github';
  const hasMode = (await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'integration_mode'")).rowCount;
  if (hasMode) assert.deepEqual((await applyPilot(db.pool, parsePilot(r))).changes.filter((c) => c.includes('integration_mode')), ['project prj_pilot: integration_mode github']);
  else await assert.rejects(applyPilot(db.pool, parsePilot(r)), /needs migration 0016/);
});

test('the coordinator key is created once, owner-only, and never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-key-'));
  try {
    const file = path.join(dir, 'keys', 'server.key');
    const made = ensureServerKey(file);
    assert.equal(made.created, true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const again = ensureServerKey(file);
    assert.deepEqual([again.created, again.publicKey, again.fingerprint], [false, made.publicKey, made.fingerprint]);
    fs.chmodSync(file, 0o644);
    assert.throws(() => ensureServerKey(file), /must not be readable by others/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
