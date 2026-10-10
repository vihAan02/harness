// The server's entry point refuses to serve the pilot from a database it wasn't given (D-142).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const MAIN = path.resolve(import.meta.dirname, '../src/main.ts');
const run = promisify(execFile);

test('device-key mode without HARNESS_DATABASE_URL exits before touching any database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srvmain-'));
  try {
    const key = path.join(dir, 'server.key');
    fs.writeFileSync(key, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: dir, HARNESS_AUTH: 'device-key', HARNESS_SERVER_KEY_FILE: key, HARNESS_PORT: '0' };
    const err = await run(process.execPath, [MAIN], { env, timeout: 20_000 }).then(() => null, (e: { code?: number; stderr?: string }) => e);
    assert.ok(err, 'the server started without being told its database');
    assert.equal(err.code, 2);
    assert.match(String(err.stderr), /HARNESS_DATABASE_URL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
