#!/usr/bin/env node
// Runs the coordination server on this machine: migrate, then serve on loopback (D-74).
// - HARNESS_AUTH=local-token (default): every client presents HARNESS_LOCAL_TOKEN. Loopback test and demo stacks.
// - HARNESS_AUTH=device-key: the two-Mac pilot (D-111). HARNESS_SERVER_KEY_FILE is the coordinator's Ed25519 private
//   key (PKCS#8 PEM, owner-only). Clients pin its public key, printed here with its fingerprint, and reach this
//   loopback port through SSH tunnels.
import fs from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { fingerprint, parsePrivateKey, publicKeyText } from '@harness/protocol/signing';
import { createPool, migrate, DEFAULT_DATABASE_URL } from './db.ts';
import { startServer } from './server.ts';

const auth = process.env.HARNESS_AUTH ?? 'local-token';
let keys: { localToken: string } | { serverKey: KeyObject };
if (auth === 'device-key') {
  const file = process.env.HARNESS_SERVER_KEY_FILE;
  if (!file || !fs.existsSync(file)) {
    console.error('HARNESS_AUTH=device-key needs HARNESS_SERVER_KEY_FILE: the coordinator\'s private key (the admin tool creates it).');
    process.exit(2);
  }
  if (fs.statSync(file).mode & 0o077) {
    console.error(`${file} must not be readable by others: chmod 600 ${file}`);
    process.exit(2);
  }
  const serverKey = parsePrivateKey(fs.readFileSync(file, 'utf8'));
  const pub = publicKeyText(serverKey);
  console.log(`server key ${pub}\n  fingerprint ${fingerprint(pub)}: pin it as server_key in each device's config.toml, checked out of band`);
  keys = { serverKey };
} else if (auth === 'local-token') {
  const token = process.env.HARNESS_LOCAL_TOKEN;
  if (!token || token.length < 32) {
    console.error('Set HARNESS_LOCAL_TOKEN to a random secret of at least 32 characters, e.g. `export HARNESS_LOCAL_TOKEN=$(openssl rand -hex 32)`.');
    process.exit(2);
  }
  keys = { localToken: token };
} else {
  console.error('HARNESS_AUTH must be local-token or device-key');
  process.exit(2);
}
const databaseUrl = process.env.HARNESS_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const pool = createPool(databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`migrated: ${applied.join(', ')}`);
const server = await startServer({ pool, databaseUrl, ...keys, port: Number(process.env.HARNESS_PORT ?? 7400) });
console.log(`harness server listening on ${server.url} (${auth})`);

const stop = async () => {
  await server.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
