// Keys and signatures for the two-Mac pilot (D-111, D-112; docs/protocol.md §2 and §11).
// - Ed25519 keys from node:crypto, written `ed25519:<base64 SPKI DER>` (public) and PKCS#8 PEM (private).
// - A signature covers `<context>\n<canonical JSON of the payload>`, so a signature made for one purpose
//   (a hello, a dispatch) can never be replayed as another.
// - Pure functions, shared by the server, harnessd, the CLI and the UI bridge's host side. Browser code
//   never imports this module: it is a separate export (`@harness/protocol/signing`) because it needs node:crypto.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import type { ClientKind, DispatchEnvelope, DispatchKind, DispatchRejectReason, SignedDispatch } from './index.ts';

export const KEY_PREFIX = 'ed25519:';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const EPOCH = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url without padding
const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class KeyError extends Error {}

// ---------- canonical JSON ----------

/**
 * The exact bytes a signature covers: object keys sorted, `undefined` members dropped, numbers only as safe
 * integers (no floats, so no formatting ambiguity). Throws on anything else.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new TypeError('canonicalJson: numbers must be safe integers');
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v}`);
  }
}

const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// ---------- keys ----------

/** A new key pair: the private key as PKCS#8 PEM (store it 0600), the public key as `ed25519:<base64>`. */
export function generateKeyPair(): { privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: publicKeyText(publicKey) };
}

export function publicKeyText(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  if (pub.asymmetricKeyType !== 'ed25519') throw new KeyError('not an Ed25519 key');
  return KEY_PREFIX + pub.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function parsePublicKey(text: string): KeyObject {
  if (typeof text !== 'string' || !text.startsWith(KEY_PREFIX)) throw new KeyError(`a public key must start with ${KEY_PREFIX}`);
  const b64 = text.slice(KEY_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new KeyError('a public key must be base64');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new KeyError('not a valid public key');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new KeyError('not an Ed25519 key');
  return key;
}

export function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new KeyError('not a valid private key (PKCS#8 PEM expected)');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new KeyError('not an Ed25519 key');
  return key;
}

/** A short id for a public key: the first 16 hex digits of the SHA-256 of its DER (the server's `server_key_id`). */
export function keyId(publicKey: string): string {
  return sha256hex(parsePublicKey(publicKey).export({ type: 'spki', format: 'der' })).slice(0, 16);
}

/** What two humans read aloud to check a key: `SHA256:xxxx xxxx …` (eight groups of four hex digits). */
export function fingerprint(publicKey: string): string {
  const hex = sha256hex(parsePublicKey(publicKey).export({ type: 'spki', format: 'der' })).slice(0, 32);
  return `SHA256:${hex.match(/.{4}/g)!.join(' ')}`;
}

// ---------- signatures ----------

export function signPayload(key: KeyObject, context: string, payload: unknown): string {
  return sign(null, Buffer.from(`${context}\n${canonicalJson(payload)}`), key).toString('base64');
}

/** False for any malformed key, signature or payload: the caller only needs to know whether it verifies. */
export function verifyPayload(key: KeyObject | string, context: string, payload: unknown, sig: unknown): boolean {
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return false;
  let pub: KeyObject;
  let bytes: Buffer;
  try {
    pub = typeof key === 'string' ? parsePublicKey(key) : key;
    bytes = Buffer.from(`${context}\n${canonicalJson(payload)}`);
  } catch (e) {
    if (e instanceof KeyError || e instanceof TypeError) return false;
    throw e;
  }
  return verify(null, bytes, pub, Buffer.from(sig, 'base64'));
}

/** 32 random bytes, base64url: a hello or dispatch nonce. */
export function newNonce(): string {
  return randomBytes(32).toString('base64url');
}

export const isNonce = (s: unknown): s is string => typeof s === 'string' && NONCE.test(s);

// ---------- the hello handshake (D-111; protocol.md §2) ----------

export const HELLO_SERVER_CONTEXT = 'harness/hello-server/v1';
export const HELLO_DEVICE_CONTEXT = 'harness/hello-device/v1';

/** What the server signs: both nonces, its key id, and who the client says it is. */
export type HelloServerProof = { client_nonce: string; server_nonce: string; server_key_id: string; device_id: string; principal: string };
/** What the device signs: the same, plus the kind of client, so a CLI's proof can't open a harnessd connection. */
export type HelloDeviceProof = HelloServerProof & { client_kind: ClientKind };

// ---------- signed dispatch (D-112; protocol.md §11) ----------

export const DISPATCH_CONTEXT = 'harness/dispatch/v1';
export const DISPATCH_KINDS: readonly DispatchKind[] = ['start', 'resume', 'reopen', 'abandon', 'complete', 'integrate'];
const HOUR = 3_600_000;
/**
 * The longest a dispatch may live, by kind. A start may wait for its human's approval through a night's sleep;
 * an approval to merge goes stale fast.
 */
export const DISPATCH_LIFETIME_MS: Record<DispatchKind, number> = {
  start: 24 * HOUR, resume: 24 * HOUR, reopen: 24 * HOUR, abandon: 24 * HOUR, complete: 24 * HOUR, integrate: HOUR / 2,
};
/** How far ahead of the verifier's clock an issue time may be. */
export const CLOCK_SKEW_MS = 5 * 60_000;

const FIELDS = ['v', 'kind', 'project_id', 'task_id', 'agent_id', 'target_device_id', 'issuer_human_id', 'issuer_device_id', 'epoch', 'nonce', 'issued_at', 'expires_at', 'task_sha256', 'message_sha256', 'integrate'];
/** Field names that ask for local policy. Remote input never widens it (D-112, T-5b): refused, never approvable. */
const POLICY_FIELDS = ['policy', 'permissions', 'allowed_domains', 'read_allow', 'secrets', 'env', 'limits', 'budget', 'max_budget_usd', 'daily_budget_usd', 'trust', 'server_key', 'setup', 'test'];

export class DispatchError extends Error {
  reason: DispatchRejectReason;
  constructor(reason: DispatchRejectReason, message: string) {
    super(`${reason}: ${message}`);
    this.reason = reason;
  }
}

/** The one definition of a task's content hash, over what the agent is told (D-112). */
export function taskSha256(t: { title: string; text: string; scope: string[]; owner_human_id: string }): string {
  return sha256hex(canonicalJson({ v: 1, title: t.title, text: t.text, scope: [...new Set(t.scope)].sort(), owner_human_id: t.owner_human_id }));
}
export function messageSha256(text: string): string {
  return sha256hex(text);
}
/** A set of paths, order and duplicates ignored. */
export function pathsSha256(paths: string[]): string {
  return sha256hex(canonicalJson([...new Set(paths)].sort()));
}

const isoTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

/** Builds the unsigned envelope, refusing unknown fields and anything malformed (DispatchError). */
export function dispatchPayload(fields: unknown): DispatchEnvelope {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new DispatchError('malformed', 'the envelope must be an object');
  const f = fields as Record<string, unknown>;
  const asked = Object.keys(f).filter((k) => POLICY_FIELDS.includes(k));
  if (asked.length) throw new DispatchError('policy_widening', `a dispatch can't carry local policy (${asked.join(', ')})`);
  const unknown = Object.keys(f).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new DispatchError('malformed', `unknown fields: ${unknown.join(', ')}`);
  const bad = (what: string): never => { throw new DispatchError('malformed', what); };
  if (f.v !== 1) bad('v must be 1');
  if (!DISPATCH_KINDS.includes(f.kind as DispatchKind)) bad(`kind must be one of ${DISPATCH_KINDS.join(', ')}`);
  const kind = f.kind as DispatchKind;
  for (const k of ['project_id', 'task_id', 'agent_id', 'target_device_id', 'issuer_human_id', 'issuer_device_id']) {
    if (typeof f[k] !== 'string' || !ID.test(f[k] as string)) bad(`${k} is malformed`);
  }
  if (typeof f.epoch !== 'string' || !EPOCH.test(f.epoch)) bad('epoch is malformed');
  if (!isNonce(f.nonce)) bad('nonce is malformed');
  if (!isoTime(f.issued_at) || !isoTime(f.expires_at)) bad('issued_at and expires_at must be ISO times');
  if (typeof f.task_sha256 !== 'string' || !HEX64.test(f.task_sha256)) bad('task_sha256 is malformed');
  if (f.message_sha256 !== undefined && (typeof f.message_sha256 !== 'string' || !HEX64.test(f.message_sha256))) bad('message_sha256 is malformed');
  if (kind === 'reopen' && f.message_sha256 === undefined) bad('a reopen carries message_sha256');
  if (f.message_sha256 !== undefined && kind !== 'reopen' && kind !== 'resume') bad(`a ${kind} carries no message`);
  if ((kind === 'integrate') !== (f.integrate !== undefined)) bad('integrate is required for, and only for, an integrate dispatch');
  if (f.integrate !== undefined) {
    const i = f.integrate as Record<string, unknown>;
    if (typeof i !== 'object' || i === null || Array.isArray(i)) bad('integrate must be an object');
    const extra = Object.keys(i).filter((k) => !['pr_number', 'head_sha', 'base_sha', 'paths_sha256'].includes(k));
    if (extra.length) bad(`unknown integrate fields: ${extra.join(', ')}`);
    if (!Number.isSafeInteger(i.pr_number) || (i.pr_number as number) < 1) bad('integrate.pr_number is malformed');
    if (typeof i.head_sha !== 'string' || !SHA.test(i.head_sha) || typeof i.base_sha !== 'string' || !SHA.test(i.base_sha)) bad('integrate.head_sha and base_sha must be full commit ids');
    if (typeof i.paths_sha256 !== 'string' || !HEX64.test(i.paths_sha256)) bad('integrate.paths_sha256 is malformed');
  }
  return f as DispatchEnvelope;
}

export function signDispatch(key: KeyObject, fields: DispatchEnvelope): SignedDispatch {
  const envelope = dispatchPayload(fields);
  return { envelope, sig: signPayload(key, DISPATCH_CONTEXT, envelope) };
}

export type DispatchVerdict = { ok: true; envelope: DispatchEnvelope } | { ok: false; reason: DispatchRejectReason; detail: string };
/** A pinned device: its human and its key (`[trust.devices]` in harnessd's config, or `devices` on the server). */
export type TrustedDevice = { humanId: string; key: string | KeyObject };

/**
 * Checks a dispatch's form, issuer, signature and lifetime. The context checks (target device, task content,
 * epoch, nonce reuse, kind against the event) need state, so they're the caller's: see expectDispatch.
 */
export function verifyDispatch(input: unknown, trusted: (deviceId: string) => TrustedDevice | null, now: Date): DispatchVerdict {
  const no = (reason: DispatchRejectReason, detail: string): DispatchVerdict => ({ ok: false, reason, detail });
  if (input === undefined || input === null) return no('missing', 'no dispatch');
  if (typeof input !== 'object' || Array.isArray(input)) return no('malformed', 'a dispatch is { envelope, sig }');
  const d = input as Record<string, unknown>;
  if (Object.keys(d).some((k) => k !== 'envelope' && k !== 'sig')) return no('malformed', 'a dispatch is { envelope, sig }');
  let env: DispatchEnvelope;
  try {
    env = dispatchPayload(d.envelope);
  } catch (e) {
    if (e instanceof DispatchError) return no(e.reason, e.message);
    throw e;
  }
  const issuer = trusted(env.issuer_device_id);
  if (!issuer) return no('unknown_issuer', `${env.issuer_device_id} isn't a trusted device`);
  if (issuer.humanId !== env.issuer_human_id) return no('issuer_mismatch', `${env.issuer_device_id} belongs to ${issuer.humanId}, not ${env.issuer_human_id}`);
  if (!verifyPayload(issuer.key, DISPATCH_CONTEXT, env, d.sig)) return no('bad_signature', 'the signature does not verify');
  const issued = Date.parse(env.issued_at);
  const expires = Date.parse(env.expires_at);
  if (expires <= issued || expires - issued > DISPATCH_LIFETIME_MS[env.kind]) return no('lifetime', `a ${env.kind} dispatch lives at most ${DISPATCH_LIFETIME_MS[env.kind] / 60_000} minutes`);
  if (issued > now.getTime() + CLOCK_SKEW_MS) return no('not_yet_valid', 'issued in the future');
  if (expires <= now.getTime()) return no('expired', `expired at ${env.expires_at}`);
  return { ok: true, envelope: env };
}

/** The context checks: returns null if the envelope fits what the verifier expects, else why not. */
export function expectDispatch(env: DispatchEnvelope, expected: {
  kind?: DispatchKind | DispatchKind[]; project_id?: string; task_id?: string; agent_id?: string; target_device_id?: string;
  epoch?: string; task_sha256?: string; message_sha256?: string;
}): { reason: DispatchRejectReason; detail: string } | null {
  const kinds = expected.kind === undefined ? undefined : Array.isArray(expected.kind) ? expected.kind : [expected.kind];
  if (kinds && !kinds.includes(env.kind)) return { reason: 'wrong_kind', detail: `a ${env.kind} dispatch, where ${kinds.join(' or ')} was expected` };
  if (expected.target_device_id !== undefined && env.target_device_id !== expected.target_device_id) return { reason: 'wrong_target', detail: `for ${env.target_device_id}` };
  if (expected.epoch !== undefined && env.epoch !== expected.epoch) return { reason: 'wrong_epoch', detail: `from coordinator epoch ${env.epoch}` };
  for (const k of ['project_id', 'task_id', 'agent_id', 'task_sha256', 'message_sha256'] as const) {
    if (expected[k] !== undefined && env[k] !== expected[k]) return { reason: 'content_mismatch', detail: `${k} differs` };
  }
  return null;
}
