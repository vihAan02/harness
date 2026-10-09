// Loopback services an agent's sandbox can reach (D-119, TH-22). Every agent session gets a port block, so its
// sandbox has allowLocalBinding, which also allows outbound connections to localhost:* (F-58). A Postgres whose
// pg_hba trusts loopback host lines (Homebrew's default) then lets any sandboxed process log in as a superuser and
// run `COPY ... TO PROGRAM`, which executes outside the sandbox as this OS user and can read ~/.harness/device.key.
// harnessd looks for such a Postgres the way an agent would: a startup message over TCP, no password, no SQL.
// Dependency-free on purpose: the daemon package doesn't depend on pg.
import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

export type TrustLogin = { port: number; user: string };
export type ProbeResult = 'trust' | 'password' | 'not_postgres' | 'error';

/** Postgres's default port is probed even if lsof doesn't list it: without root, macOS's lsof only sees this user's processes. */
const DEFAULT_PORTS = [5432];
/** What a sandboxed agent can connect to: loopback, and wildcard listeners (which include loopback). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '*', '0.0.0.0', '[::]']);
const PROTOCOL_3_0 = 196608; // 3 << 16
const TERMINATE = Buffer.from([0x58, 0, 0, 0, 4]); // 'X', length 4

/** The TCP ports in `lsof -Fn` output that listen on loopback or a wildcard address, sorted and deduplicated. */
export function parseListeners(out: string): number[] {
  const ports = new Set<number>();
  for (const line of out.split('\n')) {
    if (!line.startsWith('n') || line.includes('->')) continue;
    const name = line.slice(1).trim();
    const i = name.lastIndexOf(':');
    const port = Number(name.slice(i + 1));
    if (i > 0 && LOOPBACK_HOSTS.has(name.slice(0, i)) && Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** TCP ports listening on 127.0.0.1, ::1 or a wildcard. [] if lsof is missing or fails (`onError` says why). */
export function loopbackListeners(onError?: (msg: string) => void): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      // lsof exits 1 when nothing matches: no listeners, not a failure.
      if (!err || (err.code === 1 && !err.killed && !String(stderr).trim())) return resolve(parseListeners(String(stdout)));
      onError?.(`lsof failed (${err.killed ? 'timed out' : String(stderr).trim().split('\n')[0] || err.message})`);
      resolve([]);
    });
  });
}

/** A Postgres v3 StartupMessage: length, protocol 3.0, then user and database, each NUL-terminated, and a final NUL. */
export function startupMessage(user: string): Buffer {
  const body = Buffer.from(`user\0${user}\0database\0postgres\0\0`, 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32BE(8 + body.length, 0);
  head.writeInt32BE(PROTOCOL_3_0, 4);
  return Buffer.concat([head, body]);
}

/**
 * Asks the server on `host:port` to log `user` in with no password and reads its first reply:
 * - AuthenticationOk ('R', code 0): 'trust'. The pg_hba line is the hole, even if the role then turns out not to exist;
 * - any other authentication request ('R': cleartext, md5, SASL...) or an ErrorResponse ('E', refused): 'password';
 * - anything else, or nothing within `timeoutMs`: 'not_postgres'; no connection at all: 'error'.
 * Never sends a password or SQL; after AuthenticationOk it sends Terminate.
 */
export function probePostgres(port: number, user: string, host = '127.0.0.1', timeoutMs = 1500): Promise<ProbeResult> {
  if (user.includes('\0')) return Promise.resolve('error');
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    let buf = Buffer.alloc(0);
    const socket = net.connect({ host, port });
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (r === 'trust') {
        socket.end(TERMINATE); // a clean logout; the server closes its side
        setTimeout(() => socket.destroy(), 1000).unref();
      } else socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(connected ? 'not_postgres' : 'error'), timeoutMs);
    socket.on('connect', () => { connected = true; socket.write(startupMessage(user)); });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 5) return;
      const type = buf[0];
      const len = buf.readInt32BE(1);
      if (type === 0x45 && len >= 4 && len < 1 << 16) return finish('password'); // 'E'
      if (type !== 0x52 || len < 8 || len >= 1 << 16) return finish('not_postgres'); // not 'R'
      if (buf.length < 9) return;
      const code = buf.readInt32BE(5);
      finish(code !== 0 ? 'password' : len === 8 ? 'trust' : 'not_postgres');
    });
    socket.on('error', () => finish(connected ? 'not_postgres' : 'error'));
    socket.on('close', () => finish(connected ? 'not_postgres' : 'error'));
  });
}

/** The names an agent would try: this OS user (Homebrew's superuser) and `postgres` (most other installs'). */
function defaultUsers(): string[] {
  let me: string | null = null;
  try { me = os.userInfo().username; } catch { /* no passwd entry */ }
  return [...new Set([...(me ? [me] : []), 'postgres'])];
}

/**
 * Every password-less login a loopback Postgres accepts: each listener (or the given ports), as each user, over both
 * 127.0.0.1 and ::1. srt's `localhost:*` rule lets an agent reach both (F-58), and their pg_hba lines are separate.
 * Probes run in parallel, each bounded by its timeout.
 */
export async function findTrustPostgres(opts: { users?: string[]; ports?: number[]; log?: (msg: string) => void } = {}): Promise<TrustLogin[]> {
  const ports = opts.ports ?? [...new Set([...(await loopbackListeners((m) => opts.log?.(`D-119: ${m}; only port ${DEFAULT_PORTS.join(', ')} was checked for password-less Postgres logins`))), ...DEFAULT_PORTS])];
  const users = opts.users ?? defaultUsers();
  const probes = ports.flatMap((port) => users.map(async (user) => {
    const r = await Promise.all(['127.0.0.1', '::1'].map((host) => probePostgres(port, user, host)));
    return r.includes('trust') ? [{ port, user }] : [];
  }));
  return (await Promise.all(probes)).flat().sort((a, b) => a.port - b.port || a.user.localeCompare(b.user));
}

/** Why harnessd won't start agents (D-119). */
export function trustRefusal(hits: TrustLogin[]): string {
  const ports = [...new Set(hits.map((h) => h.port))].sort((a, b) => a - b);
  const one = ports.length === 1;
  return `D-119: ${one ? `a loopback Postgres on port ${ports[0]} accepts` : `loopback Postgres servers on ports ${ports.join(', ')} accept`} password-less logins, `
    + `so a sandboxed agent could run programs outside its sandbox. Require passwords on ${one ? 'its' : 'their'} host lines (scripts/pilot/pg-harden.sh) `
    + `or stop ${one ? 'it' : 'them'}; harnessd won't start agents until then.`;
}
