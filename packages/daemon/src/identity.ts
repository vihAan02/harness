// This device's identity (D-111; docs/protocol.md §2). The device key is an Ed25519 private key in
// ~/.harness/device.key (owner-only). Agents and setup sandboxes can't read ~/.harness (D-98, D-69), and harnessd
// never puts the key in an agent's environment. The handshake is shared by harnessd's link, the CLI and the UI bridge.
import fs from 'node:fs';
import path from 'node:path';
import type { KeyObject } from 'node:crypto';
import { PROTOCOL_VERSION, type Auth, type Challenge, type ClientKind, type Hello, type ServerMessage, type Subscription } from '@harness/protocol';
import {
  generateKeyPair, HELLO_DEVICE_CONTEXT, HELLO_SERVER_CONTEXT, isNonce, keyId, newNonce, parsePrivateKey, publicKeyText, signPayload, verifyPayload,
  type HelloServerProof,
} from '@harness/protocol/signing';
import type { LocalConfig } from './config.ts';
import { ensureDir, readPrivateFile, type Home } from './home.ts';

/** The device key, or a clear error saying how to make one. */
export function loadDeviceKey(home: Home): KeyObject {
  if (!fs.existsSync(home.deviceKey)) throw new Error(`no device key at ${home.deviceKey}: create one with \`harness setup keygen\``);
  return parsePrivateKey(readPrivateFile(home.deviceKey));
}

/** Creates the device key once, owner-only; never overwrites one. Returns its public key. */
export function createDeviceKey(home: Home): { publicKey: string } {
  ensureDir(path.dirname(home.deviceKey));
  const { privateKeyPem, publicKey } = generateKeyPair();
  fs.writeFileSync(home.deviceKey, privateKeyPem, { mode: 0o600, flag: 'wx' }); // fails if one exists
  return { publicKey };
}

/** The public half of this device's key, as `harness setup` and doctor print it. */
export function devicePublicKey(home: Home): string {
  return publicKeyText(loadDeviceKey(home));
}

/** The server's challenge didn't verify against the pinned key: whoever answered isn't the coordinator (TH-23). */
export class ServerIdentityError extends Error {}

/**
 * A frame from the server, or null. Before the server proves its key, whoever holds the port can send anything
 * (D-111, TH-23): anything that isn't a JSON object with a string `type` is dropped, never dereferenced.
 */
export function serverFrame(data: unknown): ServerMessage | null {
  let m: unknown;
  try { m = JSON.parse(String(data)); } catch { return null; }
  return m !== null && typeof m === 'object' && !Array.isArray(m) && typeof (m as { type?: unknown }).type === 'string' ? m as ServerMessage : null;
}

/** A value from an unverified peer, safe to log: strings and numbers only, control characters replaced, at most `max` characters. */
export function untrustedText(v: unknown, max = 200): string {
  const t = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : `(${typeof v})`;
  const clean = t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** A loopback URL: 127.0.0.0/8, ::1 or localhost. */
export function isLoopbackUrl(url: string): boolean {
  let h: string;
  try { h = new URL(url).hostname; } catch { return false; }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '[::1]' || h === 'localhost';
}

/**
 * Where this config may authenticate. The shared local token is for loopback test and demo stacks only (D-111): it's
 * never sent off this machine, so a config that forgets `auth = "device-key"` can't leak it to a remote server.
 */
export function checkAuthTarget(config: LocalConfig): void {
  if (config.auth !== 'device-key' && !isLoopbackUrl(config.serverUrl)) {
    throw new Error(`config: server_url ${config.serverUrl} isn't on this machine, and the local token never leaves it: set auth = "device-key" (D-111)`);
  }
}

/**
 * One connection's handshake. `hello()` is the first message; with device keys, `answer()` checks the server's
 * challenge against the pinned key and returns the `auth` to send, or throws ServerIdentityError. Before that check
 * passes, the caller trusts nothing it receives.
 */
export class Handshake {
  config: LocalConfig;
  key: KeyObject | null;
  kind: ClientKind;
  subscribe: Subscription[];
  clientNonce = newNonce();

  constructor(o: { config: LocalConfig; deviceKey: KeyObject | null; clientKind: ClientKind; subscribe: Subscription[] }) {
    this.config = o.config;
    this.key = o.deviceKey;
    this.kind = o.clientKind;
    this.subscribe = o.subscribe;
    if (o.config.auth === 'device-key' && !o.deviceKey) throw new Error('device-key auth needs this device\'s key');
    checkAuthTarget(o.config);
  }

  get deviceKeyAuth(): boolean {
    return this.config.auth === 'device-key';
  }

  hello(): Hello {
    const base = { v: PROTOCOL_VERSION as typeof PROTOCOL_VERSION, type: 'hello' as const, client: { kind: this.kind, version: '0.0.0' }, principal: this.config.principal, subscribe: this.subscribe };
    if (this.deviceKeyAuth) return { ...base, device_id: this.config.deviceId, auth: { scheme: 'device-key', client_nonce: this.clientNonce } };
    return { ...base, ...(this.kind === 'harnessd' ? { device_id: this.config.deviceId } : {}), auth: { scheme: 'local-token', token: this.config.token } };
  }

  answer(c: Challenge): Auth {
    if (!this.deviceKeyAuth || !this.key || !this.config.serverKey) throw new ServerIdentityError('a challenge from a server this client authenticates to with a local token');
    // The fields' shapes first, so nothing unbounded reaches the canonical encoding or the verifier.
    if (!isNonce(c.server_nonce) || typeof c.server_key_id !== 'string' || typeof c.sig !== 'string' || c.sig.length > 256) {
      throw new ServerIdentityError(`the server at ${this.config.serverUrl} sent a malformed challenge (server_identity_mismatch)`);
    }
    const proof: HelloServerProof = { client_nonce: this.clientNonce, server_nonce: c.server_nonce, server_key_id: c.server_key_id, device_id: this.config.deviceId, principal: this.config.principal };
    if (c.server_key_id !== keyId(this.config.serverKey) || !verifyPayload(this.config.serverKey, HELLO_SERVER_CONTEXT, proof, c.sig)) {
      throw new ServerIdentityError(`the server at ${this.config.serverUrl} didn't prove the pinned server key (server_identity_mismatch)`);
    }
    return { v: PROTOCOL_VERSION, type: 'auth', sig: signPayload(this.key, HELLO_DEVICE_CONTEXT, { ...proof, client_kind: this.kind }) };
  }
}
