// The D-119 probe (TH-22): fake Postgres servers on 127.0.0.1 answer a startup message the way real ones do, and
// the probe must tell a password-less login from every other answer, send exactly a StartupMessage (never a
// password), and log out after AuthenticationOk. No real Postgres or lsof: this runs anywhere.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { findTrustPostgres, parseListeners, probePostgres, startupMessage, trustRefusal } from '../src/localsvc.ts';

const USER = 'd119_probe_user'; // fakes answer only this user, so another process's real probe never sees a fake "trust"
const STARTUP = 'user\0d119_probe_user\0database\0postgres\0\0';
const STARTUP_LEN = 8 + STARTUP.length;
const TERMINATE = Buffer.from([0x58, 0, 0, 0, 4]);

const msg = (type: string, payload: Buffer) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(4 + payload.length, 1);
  return Buffer.concat([head, payload]);
};
const int32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const AUTH_OK = msg('R', int32(0));
const SASL = msg('R', Buffer.concat([int32(10), Buffer.from('SCRAM-SHA-256\0\0')]));
const MD5 = msg('R', Buffer.concat([int32(5), Buffer.from([1, 2, 3, 4])]));
const ERROR = msg('E', Buffer.from('SFATAL\0C28000\0Mrole "d119_probe_user" does not exist\0\0'));

type Conn = { data: Buffer; ended: Promise<Buffer> };
const servers: net.Server[] = [];
after(() => { for (const s of servers) s.close(); });

/** A server on 127.0.0.1 that hands this test's startup message to `reply`; anything else is dropped. */
async function fake(reply: ((s: net.Socket) => void) | null): Promise<{ port: number; conns: Conn[] }> {
  const conns: Conn[] = [];
  const srv = net.createServer((s) => {
    const c: Conn = { data: Buffer.alloc(0), ended: null! };
    c.ended = new Promise((resolve) => s.on('close', () => resolve(c.data)));
    s.on('error', () => {});
    let answered = false;
    s.on('data', (d: Buffer) => {
      c.data = Buffer.concat([c.data, d]);
      if (answered || c.data.length < 8 || c.data.length < c.data.readInt32BE(0)) return;
      answered = true;
      if (!c.data.subarray(8).toString('latin1').startsWith(`user\0${USER}\0`)) return void s.destroy();
      conns.push(c);
      reply?.(s);
    });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { port: (srv.address() as net.AddressInfo).port, conns };
}

test('the StartupMessage is protocol 3.0 with user and database, and nothing else', () => {
  const m = startupMessage(USER);
  assert.equal(m.length, STARTUP_LEN);
  assert.equal(m.readInt32BE(0), STARTUP_LEN);
  assert.equal(m.readInt32BE(4), 196608);
  assert.equal(m.subarray(8).toString('latin1'), STARTUP);
});

test('AuthenticationOk is a trust login: the probe sent exactly a StartupMessage, then Terminate', async () => {
  const f = await fake((s) => s.write(AUTH_OK));
  assert.equal(await probePostgres(f.port, USER), 'trust');
  const data = await f.conns[0]!.ended; // the probe half-closed after Terminate; the fake closes its side too
  assert.equal(data.readInt32BE(0), STARTUP_LEN);
  assert.equal(data.readInt32BE(4), 196608);
  assert.equal(data.subarray(8, STARTUP_LEN).toString('latin1'), STARTUP);
  assert.deepEqual(data.subarray(STARTUP_LEN), TERMINATE, 'Terminate, and nothing else, after AuthenticationOk');
});

test('AuthenticationOk split across packets is still read', async () => {
  const f = await fake((s) => { s.write(AUTH_OK.subarray(0, 3)); setTimeout(() => s.write(AUTH_OK.subarray(3)), 50); });
  assert.equal(await probePostgres(f.port, USER), 'trust');
});

for (const [name, reply] of [['SASL', SASL], ['md5', MD5], ['an ErrorResponse (refused)', ERROR]] as const) {
  test(`${name} means a password is needed: the probe never sends one`, async () => {
    const f = await fake((s) => s.write(reply));
    assert.equal(await probePostgres(f.port, USER), 'password');
    const data = await f.conns[0]!.ended;
    assert.equal(data.length, STARTUP_LEN, 'only the StartupMessage: no password, no Terminate, no SQL');
  });
}

test('garbage, a close with no reply, or silence is not Postgres; no listener is an error', async () => {
  const garbage = await fake((s) => s.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
  assert.equal(await probePostgres(garbage.port, USER), 'not_postgres');
  const badLength = await fake((s) => s.write(Buffer.from([0x52, 0x7f, 0xff, 0xff, 0xff, 0, 0, 0, 0])));
  assert.equal(await probePostgres(badLength.port, USER), 'not_postgres');
  const closes = await fake((s) => s.end());
  assert.equal(await probePostgres(closes.port, USER), 'not_postgres');
  const silent = await fake(null);
  const t0 = Date.now();
  assert.equal(await probePostgres(silent.port, USER, '127.0.0.1', 300), 'not_postgres');
  assert.ok(Date.now() - t0 < 1500, 'bounded by the timeout');
  const gone = await fake(null);
  await new Promise<void>((r) => servers.pop()!.close(() => r()));
  assert.equal(await probePostgres(gone.port, USER), 'error');
});

test('findTrustPostgres reports every trust login, by port and user, and nothing else', async () => {
  const trust = await fake((s) => s.write(AUTH_OK));
  const sasl = await fake((s) => s.write(SASL));
  const garbage = await fake((s) => s.write('-ERR unknown command\r\n')); // what Redis says
  // A second user the fakes drop (as a non-Postgres would): only USER's login is a hit.
  const hits = await findTrustPostgres({ ports: [sasl.port, trust.port, garbage.port], users: [USER, 'someone_else'] });
  assert.deepEqual(hits, [{ port: trust.port, user: USER }]);
  assert.equal(trust.conns.length, 1);
  assert.equal(sasl.conns.length, 1);
});

test('lsof -Fn output: listeners on 127.0.0.1, ::1 and wildcards, sorted and deduplicated', () => {
  const out = [
    'p942', 'f11', 'n*:59785', 'f12', 'n*:59785',
    'p16897', 'f7', 'n[::1]:5433', 'f8', 'n127.0.0.1:5433',
    'p17000', 'f7', 'n[::1]:5432', 'f8', 'n127.0.0.1:5432',
    'p2800', 'f3', 'n127.0.0.1:11434',
    'p300', 'f4', 'n192.168.1.20:8080', 'f5', 'n[fe80::1%lo0]:631', 'f6', 'n10.0.0.2:22',
    'p301', 'f4', 'n0.0.0.0:7000', 'f5', 'n[::]:7001',
    'p302', 'f4', 'n127.0.0.1:5000->127.0.0.1:61000', 'f5', 'nlocalhost:abc', 'f6', 'n127.0.0.1:70000',
    '',
  ].join('\n');
  assert.deepEqual(parseListeners(out), [5432, 5433, 7000, 7001, 11434, 59785]);
  assert.deepEqual(parseListeners(''), []);
});

test('the refusal names the ports and the fix', () => {
  assert.equal(trustRefusal([{ port: 5433, user: 'me' }, { port: 5433, user: 'postgres' }]),
    'D-119: a loopback Postgres on port 5433 accepts password-less logins, so a sandboxed agent could run programs outside its sandbox. '
    + "Require passwords on its host lines (scripts/pilot/pg-harden.sh) or stop it; harnessd won't start agents until then.");
  assert.match(trustRefusal([{ port: 5433, user: 'me' }, { port: 5432, user: 'me' }]), /^D-119: loopback Postgres servers on ports 5432, 5433 accept password-less logins/);
});
