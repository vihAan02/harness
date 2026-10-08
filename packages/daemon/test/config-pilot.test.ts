// The pilot's local config (D-111 to D-117; docs/protocol.md §2, §11, §12): device-key auth with pinned keys,
// GitHub integration per project, budgets, the UI port. Strict, so a typo can't fall back to local mode or no trust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair } from '@harness/protocol/signing';
import { parse } from 'smol-toml';
import { parseConfig, renderConfig } from '../src/index.ts';

const TOKEN = 't'.repeat(32);
const own = generateKeyPair().publicKey;
const peer = generateKeyPair().publicKey;
const server = generateKeyPair().publicKey;
const NOTEST = { env: {} };
const TEST = { env: { HARNESS_TEST: '1' } };
const project = { id: 'prj_harness', repo: '/Users/me/code/harness-dogfood', integration: 'github', remote: 'https://github.com/vihAan02/harness.git', commit_name: 'Daniyal Mughal', commit_email: '1+DaniyalMughal1@users.noreply.github.com' };
const pilot = (over: Record<string, unknown> = {}) => ({
  device_id: 'dev_daniyal', principal: 'human_daniyal', server_url: 'ws://127.0.0.1:7400', auth: 'device-key', server_key: server,
  trust: { devices: { dev_daniyal: { human: 'human_daniyal', key: own }, dev_vihaan: { human: 'human_vihaan', key: peer } } },
  limits: { max_concurrent_agents: 1, port_range: [3100, 3999] }, agents: { max_budget_usd: 0.1, daily_budget_usd: 0.25 }, ui: { port: 7480 },
  projects: [project], ...over,
});

test('a pilot config parses: device-key auth, pinned keys, GitHub integration, budgets, the UI port', () => {
  const c = parseConfig(pilot(), '', NOTEST);
  assert.equal(c.auth, 'device-key');
  assert.equal(c.token, '');
  assert.equal(c.serverKey, server);
  assert.deepEqual(c.trustedDevices.dev_vihaan, { humanId: 'human_vihaan', key: peer });
  assert.equal(c.agents.dailyBudgetUsd, 0.25);
  assert.equal(c.ui.port, 7480);
  const p = c.projects[0]!;
  assert.equal(p.integration, 'github');
  assert.equal(p.githubRepo, 'vihAan02/harness');
  assert.equal(p.githubApi, 'https://api.github.com');
  assert.deepEqual(p.commitIdentity, { name: 'Daniyal Mughal', email: '1+DaniyalMughal1@users.noreply.github.com' });
  assert.equal(p.requireDispatch, true, 'forced on with device keys and GitHub');
});

test('local-token configs are unchanged: local integration, no dispatch required, no trust needed', () => {
  const c = parseConfig({ device_id: 'dev_a', principal: 'human_a', projects: [{ id: 'prj_a', repo: '/r' }] }, TOKEN);
  assert.equal(c.auth, 'local-token');
  assert.equal(c.token, TOKEN);
  assert.equal(c.serverKey, null);
  assert.deepEqual(Object.keys(c.trustedDevices), []);
  assert.equal(c.ui.port, null);
  assert.deepEqual({ ...c.projects[0]! }, { id: 'prj_a', repo: '/r', baseBranch: 'main', secrets: [], integration: 'local', remote: null, githubRepo: null, githubApi: 'https://api.github.com', commitIdentity: null, requireDispatch: false });
  assert.equal(parseConfig({ device_id: 'dev_a', principal: 'human_a', projects: [{ id: 'prj_a', repo: '/r', require_dispatch: true }] }, TOKEN).projects[0]!.requireDispatch, true);
});

test('device-key needs a pinned server key, its own device pinned to its own human, and both budgets', () => {
  const bad = (raw: Record<string, unknown>, re: RegExp) => assert.throws(() => parseConfig(raw, '', NOTEST), re);
  bad(pilot({ server_key: undefined }), /server_key/);
  bad(pilot({ server_key: 'ssh-ed25519 AAAA' }), /server_key/);
  bad(pilot({ trust: { devices: { dev_vihaan: { human: 'human_vihaan', key: peer } } } }), /must pin this device/);
  bad(pilot({ trust: { devices: { dev_daniyal: { human: 'human_vihaan', key: own } } } }), /must be this device's principal/);
  bad(pilot({ trust: { devices: { dev_daniyal: { human: 'human_daniyal', key: 'ed25519:AAAA' } } } }), /trust.devices.dev_daniyal.key/);
  bad(pilot({ trust: { devices: { dev_daniyal: { human: 'human_daniyal', key: own, role: 'admin' } } } }), /unknown keys: role/);
  bad(pilot({ trust: { devices: {}, servers: {} } }), /\[trust\] has unknown keys/);
  bad(pilot({ agents: { max_budget_usd: 0.1 } }), /daily_budget_usd/);
  bad(pilot({ agents: { daily_budget_usd: 0.25 } }), /max_budget_usd/);
  bad(pilot({ auth: 'password' }), /auth must be/);
  assert.throws(() => parseConfig({ device_id: 'dev_a', principal: 'human_a', server_key: server }, TOKEN), /server_key is for auth = "device-key"/);
});

test('GitHub integration: https on github.com, no credentials in the URL, a commit identity, and no way to turn dispatch off', () => {
  const bad = (p: Record<string, unknown>, re: RegExp, opts = NOTEST) => assert.throws(() => parseConfig(pilot({ projects: [{ ...project, ...p }] }), '', opts), re, JSON.stringify(p));
  bad({ remote: 'git@github.com:vihAan02/harness.git' }, /not a URL|https/);
  bad({ remote: 'http://github.com/vihAan02/harness.git' }, /must be https/);
  bad({ remote: 'https://x-access-token:ghp_abc@github.com/vihAan02/harness.git' }, /credentials/);
  bad({ remote: 'https://github.com/vihAan02/harness.git?token=1' }, /credentials, a query/);
  bad({ remote: 'https://gitlab.com/vihAan02/harness.git' }, /github.com/);
  bad({ remote: 'https://github.com/vihAan02' }, /<owner>\/<repo>/);
  bad({ github_api: 'https://evil.example' }, /github_api must be/);
  bad({ commit_email: undefined }, /commit_email/);
  bad({ commit_name: 'x <evil@x>' }, /commit_name/);
  bad({ require_dispatch: false }, /can't be false/);
  bad({ integration: 'gitlab' }, /integration must be/);
  bad({ auto_merge: true }, /unknown keys: auto_merge/);
  // A local project can't carry GitHub settings, and require_dispatch is forced on with device keys anyway.
  assert.throws(() => parseConfig(pilot({ projects: [{ id: 'prj_a', repo: '/r', remote: 'https://github.com/a/b.git' }] }), '', NOTEST), /is for integration = "github"/);
  assert.equal(parseConfig(pilot({ projects: [{ id: 'prj_a', repo: '/r' }] }), '', NOTEST).projects[0]!.requireDispatch, true);
  // Under HARNESS_TEST=1 only, the remote and API may point at a fake GitHub on loopback.
  const fake = parseConfig(pilot({ projects: [{ ...project, remote: 'https://127.0.0.1:4443/o/r.git', github_api: 'https://127.0.0.1:4443/api/' }] }), '', TEST).projects[0]!;
  assert.equal(fake.githubRepo, 'o/r');
  assert.equal(fake.githubApi, 'https://127.0.0.1:4443/api');
  bad({ remote: 'https://127.0.0.1:4443/o/r.git' }, /github.com/);
});

test('budgets, the UI port and unknown keys', () => {
  const bad = (raw: Record<string, unknown>, re: RegExp) => assert.throws(() => parseConfig(raw, '', NOTEST), re);
  bad(pilot({ agents: { max_budget_usd: 0.1, daily_budget_usd: 0 } }), /daily_budget_usd/);
  bad(pilot({ agents: { max_budget_usd: 0.1, daily_budget_usd: 0.25, budget: 9 } }), /\[agents\] has unknown keys: budget/);
  bad(pilot({ ui: { port: 3500 } }), /outside limits.port_range/);
  bad(pilot({ ui: { port: 80 } }), /ui.port/);
  bad(pilot({ ui: { port: 7480, host: '0.0.0.0' } }), /\[ui\] has unknown keys: host/);
});

test('renderConfig writes only what harnessd would accept, and round-trips', () => {
  const raw = pilot();
  const text = renderConfig(raw, NOTEST);
  assert.deepEqual(parseConfig(parse(text) as Record<string, unknown>, '', NOTEST), parseConfig(raw, '', NOTEST));
  assert.ok(!/token/i.test(text), 'no token is ever written');
  assert.throws(() => renderConfig(pilot({ server_key: undefined }), NOTEST), /server_key/);
});
