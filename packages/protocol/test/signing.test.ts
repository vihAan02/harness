// The pilot's keys and signatures (D-111, D-112): canonical bytes, key formats, context binding, and every way a
// dispatch is refused. The fixed vector pins the canonical encoding: any implementation that signs a dispatch must
// produce these bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import type { DispatchEnvelope } from '../src/index.ts';
import {
  canonicalJson, CLOCK_SKEW_MS, DISPATCH_CONTEXT, dispatchPayload, DispatchError, expectDispatch, fingerprint, generateKeyPair, keyId, KeyError,
  messageSha256, newNonce, parsePrivateKey, parsePublicKey, pathsSha256, publicKeyText, signDispatch, signPayload, taskSha256, verifyDispatch,
  verifyPayload, type TrustedDevice,
} from '../src/signing.ts';

// A test-only key, built from its 32-byte seed (no PEM in the repo).
const SEED = 'fdafd2a26a925c245a20649ed927e55b9654061fa97da5eb3f414286a0dd6517';
const FIXED = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(SEED, 'hex')]), format: 'der', type: 'pkcs8' });
const FIXED_PUB = 'ed25519:MCowBQYDK2VwAyEAZiPWk03toE+ALKBbh23TkcQjgvBbUvJpxvBVJY2E22s=';

const NOW = new Date('2026-10-08T12:30:00.000Z');
const task = { title: 't', text: 'x', scope: ['src/'], owner_human_id: 'human_a' };
const envelope = (over: Partial<DispatchEnvelope> = {}): DispatchEnvelope => ({
  v: 1, kind: 'start', project_id: 'prj_shelf', task_id: 'T-1', agent_id: 'agent_a', target_device_id: 'dev_a',
  issuer_human_id: 'human_a', issuer_device_id: 'dev_a', epoch: 'ep0c0ffee', nonce: 'A'.repeat(43),
  issued_at: '2026-10-08T12:00:00.000Z', expires_at: '2026-10-08T13:00:00.000Z', task_sha256: taskSha256(task), ...over,
});
const trust = (devices: Record<string, TrustedDevice>) => (id: string) => devices[id] ?? null;
const pinned = trust({ dev_a: { humanId: 'human_a', key: FIXED_PUB } });

test('canonical JSON: keys sorted at every depth, undefined dropped, only safe integers', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: null, x: 'é' }], c: true } }), '{"a":{"c":true,"d":[3,{"x":"é","y":null}]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  assert.throws(() => canonicalJson({ a: 1.5 }), TypeError);
  assert.throws(() => canonicalJson({ a: 2 ** 60 }), TypeError);
  assert.throws(() => canonicalJson({ a: () => 1 }), TypeError);
});

test('the fixed vector: the same key and envelope always give the same bytes and signature', () => {
  assert.equal(publicKeyText(FIXED), FIXED_PUB);
  assert.equal(taskSha256(task), 'c603f093b2e5b39c97057903e8dc9133ed8aad52986009e911a3f430c76d79d3');
  assert.equal(canonicalJson(envelope()), '{"agent_id":"agent_a","epoch":"ep0c0ffee","expires_at":"2026-10-08T13:00:00.000Z","issued_at":"2026-10-08T12:00:00.000Z","issuer_device_id":"dev_a","issuer_human_id":"human_a","kind":"start","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","project_id":"prj_shelf","target_device_id":"dev_a","task_id":"T-1","task_sha256":"c603f093b2e5b39c97057903e8dc9133ed8aad52986009e911a3f430c76d79d3","v":1}');
  assert.equal(signDispatch(FIXED, envelope()).sig, 'pbefipDV/00qeimrHHMnK8XoKQYjAJfoQpE4lBxQA14ea6hJmztiV4qnOLAAbE0pGWtXnPTrGRUOJgENV35UDw==');
  assert.equal(fingerprint(FIXED_PUB), 'SHA256:f498 d9be f5ab 1cbd 1fff 0170 e274 27ec');
  assert.equal(keyId(FIXED_PUB), 'f498d9bef5ab1cbd');
});

test('keys: generate, parse and print round-trip; anything but Ed25519 is refused', () => {
  const k = generateKeyPair();
  assert.match(k.publicKey, /^ed25519:[A-Za-z0-9+/]+=*$/);
  assert.equal(publicKeyText(parsePrivateKey(k.privateKeyPem)), k.publicKey);
  assert.equal(publicKeyText(parsePublicKey(k.publicKey)), k.publicKey);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => parsePublicKey(`ed25519:${rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`), KeyError);
  assert.throws(() => parsePrivateKey(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), KeyError);
  for (const bad of ['', 'MCowBQYDK2VwAyEAZiPW', 'ed25519:', 'ed25519:not base64!', 'ed25519:AAAA']) assert.throws(() => parsePublicKey(bad), KeyError, bad);
  assert.throws(() => parsePrivateKey('not a key'), KeyError);
});

test('a signature is bound to its context and its exact payload', () => {
  const sig = signPayload(FIXED, 'ctx/a', { x: 1 });
  assert.ok(verifyPayload(FIXED_PUB, 'ctx/a', { x: 1 }, sig));
  assert.ok(!verifyPayload(FIXED_PUB, 'ctx/b', { x: 1 }, sig), 'another context');
  assert.ok(!verifyPayload(FIXED_PUB, 'ctx/a', { x: 2 }, sig), 'another payload');
  assert.ok(!verifyPayload(generateKeyPair().publicKey, 'ctx/a', { x: 1 }, sig), 'another key');
  for (const bad of [undefined, 42, '', 'AAAA', `${sig.slice(0, -4)}AA==`]) assert.ok(!verifyPayload(FIXED_PUB, 'ctx/a', { x: 1 }, bad), String(bad));
  assert.ok(!verifyPayload('ed25519:garbage', 'ctx/a', { x: 1 }, sig), 'a malformed key is a failed check, not a throw');
  assert.match(newNonce(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newNonce(), newNonce());
});

test('a valid dispatch verifies, for every kind with its own fields', () => {
  const kinds: Partial<DispatchEnvelope>[] = [
    { kind: 'start' }, { kind: 'resume' }, { kind: 'resume', message_sha256: messageSha256('carry on') },
    { kind: 'reopen', message_sha256: messageSha256('fix the test') }, { kind: 'abandon' }, { kind: 'complete' },
    { kind: 'integrate', expires_at: '2026-10-08T12:30:00.000Z', integrate: { pr_number: 7, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), paths_sha256: pathsSha256(['b', 'a', 'b']) } },
  ];
  for (const over of kinds) {
    const v = verifyDispatch(signDispatch(FIXED, envelope(over)), pinned, new Date('2026-10-08T12:10:00.000Z'));
    assert.ok(v.ok, `${over.kind}: ${v.ok ? '' : v.detail}`);
  }
  assert.equal(pathsSha256(['b', 'a']), pathsSha256(['a', 'b', 'a']));
  assert.equal(taskSha256({ ...task, scope: ['b/', 'a/'] }), taskSha256({ ...task, scope: ['a/', 'b/', 'a/'] }));
  assert.notEqual(taskSha256(task), taskSha256({ ...task, text: 'y' }));
});

test('T-3 at the unit level: every forgery or tampering is refused with its reason', () => {
  const good = signDispatch(FIXED, envelope());
  const reason = (input: unknown, at = NOW, devices = pinned) => { const v = verifyDispatch(input, devices, at); return v.ok ? 'ok' : v.reason; };
  assert.equal(reason(good), 'ok');
  assert.equal(reason(undefined), 'missing');
  assert.equal(reason(null), 'missing');
  assert.equal(reason({ envelope: envelope() }), 'bad_signature');
  assert.equal(reason({ ...good, extra: 1 }), 'malformed');
  // Every field, changed after signing.
  for (const [k, v] of Object.entries({ kind: 'abandon', project_id: 'prj_x', task_id: 'T-2', agent_id: 'agent_b', target_device_id: 'dev_b', epoch: 'ep1111111', nonce: 'B'.repeat(43), issued_at: '2026-10-08T12:01:00.000Z', expires_at: '2026-10-08T12:59:00.000Z', task_sha256: 'f'.repeat(64) })) {
    assert.equal(reason({ envelope: { ...good.envelope, [k]: v }, sig: good.sig }), 'bad_signature', k);
  }
  assert.equal(reason({ envelope: { ...good.envelope, issuer_human_id: 'human_b' }, sig: good.sig }), 'issuer_mismatch');
  assert.equal(reason({ envelope: { ...good.envelope, issuer_device_id: 'dev_x' }, sig: good.sig }), 'unknown_issuer');
  // A key pinned for another human can't vouch for this one.
  assert.equal(reason(good, NOW, trust({ dev_a: { humanId: 'human_b', key: FIXED_PUB } })), 'issuer_mismatch');
  // Signed by a key that isn't the one pinned for that device.
  const other = generateKeyPairSync('ed25519').privateKey;
  assert.equal(reason(signDispatch(other, envelope())), 'bad_signature');
  // Time.
  assert.equal(reason(good, new Date('2026-10-08T13:00:00.000Z')), 'expired');
  assert.equal(reason(good, new Date(Date.parse('2026-10-08T12:00:00.000Z') - CLOCK_SKEW_MS - 1000)), 'not_yet_valid');
  assert.equal(reason(signDispatch(FIXED, envelope({ expires_at: '2026-10-10T12:00:00.000Z' }))), 'lifetime');
  assert.equal(reason(signDispatch(FIXED, envelope({ kind: 'integrate', integrate: { pr_number: 1, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), paths_sha256: pathsSha256([]) } }))), 'lifetime', 'an integrate lives 30 minutes at most');
});

test('T-5b at the unit level: a dispatch never carries local policy, and unknown or malformed fields are refused', () => {
  const refuse = (over: Record<string, unknown>, why: string) => assert.throws(() => dispatchPayload({ ...envelope(), ...over }), (e: unknown) => e instanceof DispatchError && e.reason === why, JSON.stringify(over));
  for (const k of ['allowed_domains', 'read_allow', 'secrets', 'limits', 'max_budget_usd', 'trust', 'server_key', 'policy']) refuse({ [k]: ['*'] }, 'policy_widening');
  refuse({ note: 'hi' }, 'malformed');
  refuse({ v: 2 }, 'malformed');
  refuse({ kind: 'merge' }, 'malformed');
  refuse({ task_id: 'T 1' }, 'malformed');
  refuse({ nonce: 'short' }, 'malformed');
  refuse({ issued_at: '2026-10-08 12:00' }, 'malformed');
  refuse({ kind: 'reopen' }, 'malformed'); // a reopen carries its message's hash
  refuse({ message_sha256: messageSha256('x') }, 'malformed'); // a start carries no message
  refuse({ kind: 'integrate' }, 'malformed'); // an integrate carries what was approved
  refuse({ integrate: { pr_number: 1, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), paths_sha256: pathsSha256([]) } }, 'malformed');
  refuse({ kind: 'integrate', integrate: { pr_number: 1, head_sha: 'main', base_sha: 'b'.repeat(40), paths_sha256: pathsSha256([]) } }, 'malformed');
  refuse({ kind: 'integrate', integrate: { pr_number: 1, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), paths_sha256: pathsSha256([]), auto_merge: true } }, 'malformed');
  // The same checks hold through verifyDispatch, before any signature work.
  const v = verifyDispatch({ envelope: { ...envelope(), read_allow: ['~'] }, sig: 'x' }, pinned, NOW);
  assert.deepEqual(v.ok ? null : v.reason, 'policy_widening');
});

test('the context checks: kind, target device, epoch and content', () => {
  const env = envelope();
  assert.equal(expectDispatch(env, { kind: 'start', target_device_id: 'dev_a', epoch: 'ep0c0ffee', task_id: 'T-1', task_sha256: taskSha256(task) }), null);
  assert.equal(expectDispatch(env, { kind: ['resume', 'reopen'] })?.reason, 'wrong_kind');
  assert.equal(expectDispatch(env, { target_device_id: 'dev_b' })?.reason, 'wrong_target');
  assert.equal(expectDispatch(env, { epoch: 'ep1111111' })?.reason, 'wrong_epoch');
  assert.equal(expectDispatch(env, { task_sha256: taskSha256({ ...task, text: 'the server changed the text' }) })?.reason, 'content_mismatch');
  assert.equal(expectDispatch(env, { agent_id: 'agent_b' })?.reason, 'content_mismatch');
  assert.equal(DISPATCH_CONTEXT, 'harness/dispatch/v1');
});
