// `harness setup` pins only what the human typed (D-111), and refuses what would make a config wrong or unsafe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnessHome, loadConfig } from '@harness/daemon';
import { generateKeyPair } from '@harness/protocol/signing';
import { keygen, writeSetup, type SetupOptions } from '../src/setup.ts';

test('setup writes a pilot config from typed pins only, and refuses the wrong ones', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-setup-')));
  try {
    const home = harnessHome(path.join(dir, 'home'));
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    const server = generateKeyPair().publicKey;
    const other = generateKeyPair().publicKey;
    const o = (over: Partial<SetupOptions> = {}): SetupOptions => ({
      device: 'dev_a', principal: 'human_a', serverUrl: 'ws://127.0.0.1:7400', serverKey: server, trust: [`dev_b=human_b:${other}`],
      project: 'prj_pilot', repo, baseBranch: 'main', integration: 'local', force: false, ...over,
    });
    assert.throws(() => writeSetup(home, o()), /no device key yet: run harness setup keygen first/);
    const out = keygen(home, 'dev_a');
    const own = /public_key = "(ed25519:[^"]+)"/.exec(out)![1]!;
    assert.throws(() => keygen(home, 'dev_a'), /already exists; a device keeps its key/);
    assert.throws(() => writeSetup(home, o({ trust: ['dev_b=human_b'] })), /use <device_id>=<human_id>:ed25519/);
    assert.throws(() => writeSetup(home, o({ trust: [`dev_b=human_b:${own}`] })), /has this device's own key/);
    assert.throws(() => writeSetup(home, o({ trust: [`dev_a=human_a:${other}`] })), /with a key other than this device's own/);
    assert.throws(() => writeSetup(home, o({ serverKey: other })), /is a device's key, not the coordinator's/);
    assert.throws(() => writeSetup(home, o({ serverKey: 'ed25519:nope' })), /--server-key must be an Ed25519 key/);
    assert.throws(() => writeSetup(home, o({ repo: 'relative/path' })), /absolute path of a git clone/);
    assert.throws(() => writeSetup(home, o({ integration: 'github' })), /needs --remote, --commit-name and --commit-email/);
    assert.throws(() => writeSetup(home, o({ provider: 'no-such-provider' })), /no \[providers\.no-such-provider\]/);
    const file = writeSetup(home, o());
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const config = loadConfig(home);
    assert.deepEqual({ ...config.trustedDevices }, { dev_a: { humanId: 'human_a', key: own }, dev_b: { humanId: 'human_b', key: other } });
    assert.equal(config.serverKey, server);
    assert.throws(() => writeSetup(home, o()), /exists; re-run with --force/);
    writeSetup(home, o({ force: true, trust: [] }));
    assert.deepEqual(Object.keys(loadConfig(home).trustedDevices), ['dev_a']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
