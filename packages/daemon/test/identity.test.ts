// The client side of the handshake (D-111, TH-23): before the server proves its key, whoever answers can send
// anything, and nothing it sends may crash harnessd or the CLI. The shared local token never leaves this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseConfig } from '../src/config.ts';
import { checkAuthTarget, createDeviceKey, Handshake, isLoopbackUrl, loadDeviceKey, serverFrame, ServerIdentityError, untrustedText } from '../src/identity.ts';
import { generateKeyPair, HELLO_SERVER_CONTEXT, keyId, newNonce, parsePrivateKey, signPayload } from '@harness/protocol/signing';
import { tempDir, tempHome } from './fixtures.ts';

const deep = (n: number) => '['.repeat(n) + ']'.repeat(n);

test('serverFrame keeps only JSON objects with a string type', () => {
  for (const bad of ['not json', 'null', '42', '"x"', '[]', '{}', '{"type":7}', deep(50_000)]) assert.equal(serverFrame(bad), null, bad.slice(0, 20));
  assert.deepEqual(serverFrame('{"type":"error","code":"x"}'), { type: 'error', code: 'x' });
});

test('untrustedText prints strings and numbers only, without control characters, bounded', () => {
  assert.equal(untrustedText('a\nb\u0007c d'), 'a b c d');
  assert.equal(untrustedText(7), '7');
  assert.equal(untrustedText(JSON.parse(deep(50_000))), '(object)', 'never stringifies a nested value');
  assert.equal(untrustedText('x'.repeat(500)).length, 201);
});

test('the shared local token never leaves this machine', () => {
  for (const u of ['ws://127.0.0.1:7400', 'ws://127.9.0.1:1', 'ws://localhost:7400', 'ws://[::1]:7400']) assert.ok(isLoopbackUrl(u), u);
  for (const u of ['wss://coordinator.example', 'ws://10.0.0.5:7400', 'ws://127.0.0.1.evil.example', 'not a url']) assert.ok(!isLoopbackUrl(u), u);
  const config = parseConfig({ device_id: 'dev_a', principal: 'human_a', server_url: 'wss://coordinator.example', projects: [] }, 'tok');
  assert.throws(() => checkAuthTarget(config), /isn't on this machine, and the local token never leaves it/);
  assert.throws(() => new Handshake({ config, deviceKey: null, clientKind: 'cli', subscribe: [] }), /never leaves it/);
  checkAuthTarget({ ...config, serverUrl: 'ws://127.0.0.1:7400' });
});

test('a malformed challenge is refused before anything is encoded or verified; a 0644 device key is refused', () => {
  const t = tempDir('identity-unit');
  try {
    const home = tempHome(t.dir);
    const { publicKey } = createDeviceKey(home);
    const server = generateKeyPair();
    const config = parseConfig({
      device_id: 'dev_a', principal: 'human_a', server_url: 'ws://127.0.0.1:7400', auth: 'device-key', server_key: server.publicKey,
      trust: { devices: { dev_a: { human: 'human_a', key: publicKey } } }, agents: { max_budget_usd: 0.1, daily_budget_usd: 0.25 }, projects: [],
    }, '');
    const hs = new Handshake({ config, deviceKey: loadDeviceKey(home), clientKind: 'harnessd', subscribe: [] });
    const id = keyId(server.publicKey);
    const sig = signPayload(parsePrivateKey(generateKeyPair().privateKeyPem), HELLO_SERVER_CONTEXT, {});
    for (const c of [
      { server_nonce: JSON.parse(deep(50_000)), server_key_id: id, sig },
      { server_nonce: 'short', server_key_id: id, sig },
      { server_nonce: newNonce(), server_key_id: { id }, sig },
      { server_nonce: newNonce(), server_key_id: id, sig: 'x'.repeat(10_000) },
      { server_nonce: newNonce(), server_key_id: id, sig: null },
    ]) {
      assert.throws(() => hs.answer({ v: 1, type: 'challenge', ...c } as never), (e: unknown) => e instanceof ServerIdentityError && /malformed challenge/.test((e as Error).message));
    }
    // Well-formed, but not the pinned server's signature: a mismatch.
    assert.throws(() => hs.answer({ v: 1, type: 'challenge', server_nonce: newNonce(), server_key_id: id, sig }), /didn't prove the pinned server key/);
    fs.chmodSync(home.deviceKey, 0o644);
    assert.throws(() => loadDeviceKey(home), /must not be readable by others/);
  } finally { t.cleanup(); }
});
