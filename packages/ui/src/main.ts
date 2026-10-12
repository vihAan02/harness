// `harness ui` (D-117; protocol.md §12): the launcher for the local UI bridge.
//   node packages/ui/src/main.ts serve             start the bridge and print its URL
//   node packages/ui/src/main.ts open [--print]    prove the bridge is ours, then open the launched page
// It reads ~/.harness (the secret, the harnessd socket token) and never logs either.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { harnessHome, loadConfig, type Home } from '@harness/daemon';
import { startBridge } from './bridge.ts';
import { UirpcClient } from './uirpc-client.ts';

/** 32 random bytes at mode 0600 in a 0700 directory, created once and otherwise read back. */
function bridgeSecret(home: Home): Buffer {
  fs.mkdirSync(home.ui, { recursive: true, mode: 0o700 });
  fs.chmodSync(home.ui, 0o700);
  const file = path.join(home.ui, 'bridge.secret');
  try {
    const existing = fs.readFileSync(file);
    if (existing.length) return existing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const secret = randomBytes(32);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function requirePort(home: Home): number {
  const port = loadConfig(home).ui.port;
  if (port === null) throw new Error(`config: [ui] port is required in ${home.config} (D-117)`);
  return port;
}

/** One JSON POST to the bridge, with the Host header it insists on. */
function post(port: number, route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: route,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': payload.length },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { /* a non-JSON reply is a refusal */ }
        resolve({ status: res.statusCode ?? 0, json: parsed });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function constTime(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function serve(home: Home): Promise<void> {
  const port = requirePort(home);
  const secret = bridgeSecret(home);
  const uirpc = new UirpcClient({
    connect: () => net.connect(path.join(home.run, 'harnessd.sock')),
    token: () => fs.readFileSync(path.join(home.run, 'uirpc.token'), 'utf8').trim(),
  });
  const bridge = await startBridge({ port, uirpc, webRoot: path.join(import.meta.dirname, '..', 'web'), secret });
  console.log(`harness ui: ${bridge.url} (run \`harness ui open\` to launch it)`);
  const stop = () => { void bridge.close().then(() => { uirpc.close(); process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function open(home: Home, print: boolean): Promise<void> {
  const port = requirePort(home);
  const secret = bridgeSecret(home);
  const nonce_c = randomBytes(32).toString('hex');
  const challenge = await post(port, '/api/launch/challenge', { nonce_c });
  const nonce_b = challenge.json.nonce_b;
  const proof = challenge.json.proof;
  if (challenge.status !== 200 || typeof nonce_b !== 'string' || typeof proof !== 'string' || !constTime(proof, createHmac('sha256', secret).update(`bridge:${nonce_c}${nonce_b}`).digest('hex'))) {
    console.error('something else holds the UI port');
    process.exit(1);
  }
  const mac = createHmac('sha256', secret).update(`launch:${nonce_c}${nonce_b}`).digest('hex');
  const launched = await post(port, '/api/launch', { nonce_c, nonce_b, mac });
  const token = launched.json.launch_token;
  if (launched.status !== 200 || typeof token !== 'string') {
    console.error('something else holds the UI port');
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}/launch#t=${token}`;
  if (print) return void console.log(url);
  spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true }).unref();
}

const [command, ...flags] = process.argv.slice(2);
const home = harnessHome();
try {
  if (command === 'serve') await serve(home);
  else if (command === 'open') await open(home, flags.includes('--print'));
  else {
    console.error('usage: harness ui serve | harness ui open [--print]');
    process.exit(2);
  }
} catch (e) {
  console.error(`harness ui: ${(e as Error).message}`);
  process.exit(1);
}
