// The UI bridge's uirpc client (D-117). Every test runs over an in-memory Duplex pair, so nothing here opens a
// socket or listens on a port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { UirpcClient, UirpcError } from '../src/uirpc-client.ts';

/** One end of an in-memory pipe: what it writes appears on its peer's readable side. */
class Wire extends Duplex {
  peer: Wire;
  constructor(peer: Wire) {
    super();
    this.peer = peer;
    this.on('close', () => { if (!this.peer.destroyed) this.peer.destroy(); });
  }
  _read(): void {}
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.peer.push(chunk);
    cb();
  }
}

/** A pair of connected wires: [client end, server end]. */
function pair(): [Wire, Wire] {
  const a = new Wire(null as unknown as Wire);
  const b = new Wire(a);
  a.peer = b;
  return [a, b];
}

/** Reads newline-delimited JSON off a wire and answers each request through `reply`. */
function serve(wire: Wire, reply: (m: { id: unknown; token?: unknown; method?: string; params?: unknown }) => unknown): void {
  let buf = '';
  wire.setEncoding('utf8');
  wire.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as { id: unknown };
      const answer = reply(m);
      if (answer !== undefined) wire.write(`${JSON.stringify(answer)}\n`);
    }
  });
}

const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const p = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('call: one shared connection, replies matched by id', async () => {
  const seen: Array<{ id: number; token: string; method: string; params: unknown }> = [];
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, (m) => { seen.push(m as never); return undefined; }); return c; },
    token: () => 'tok',
  });
  const a = client.call('snapshot', {});
  const b = client.call('health', { project_id: 'p1' });
  await tick();
  assert.equal(sockets.length, 1, 'both calls share one connection');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((m) => m.method), ['snapshot', 'health']);
  assert.deepEqual(seen.map((m) => m.id), [1, 2]);
  assert.deepEqual(seen[1]?.params, { project_id: 'p1' });
  // Answer out of order: each call still gets its own result.
  sockets[0]?.write(`${JSON.stringify({ id: 2, ok: true, result: 'second' })}\n${JSON.stringify({ id: 1, ok: true, result: 'first' })}\n`);
  assert.equal(await a, 'first');
  assert.equal(await b, 'second');
  client.close();
});

test('call: ok:false rejects with the code and message from harnessd', async () => {
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); serve(s, (m) => ({ id: (m as { id: number }).id, ok: false, error: { code: 'conflict', message: 'not what was shown' } })); return c; },
    token: () => 'tok',
  });
  await assert.rejects(client.call('approve', { id: 'x' }), (e: unknown) => {
    assert.ok(e instanceof UirpcError);
    assert.equal(e.code, 'conflict');
    assert.equal(e.message, 'not what was shown');
    return true;
  });
  client.close();
});

test('call: no reply within timeoutMs rejects as timeout', async () => {
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); serve(s, () => undefined); return c; },
    token: () => 'tok',
    timeoutMs: 20,
  });
  await assert.rejects(client.call('snapshot', {}), (e: unknown) => e instanceof UirpcError && e.code === 'timeout');
  client.close();
});

test('call: a close rejects every pending call as unavailable', async () => {
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, () => undefined); return c; },
    token: () => 'tok',
  });
  const a = client.call('snapshot', {});
  const b = client.call('health', {});
  await tick();
  sockets[0]?.destroy();
  await assert.rejects(a, (e: unknown) => e instanceof UirpcError && e.code === 'unavailable');
  await assert.rejects(b, (e: unknown) => e instanceof UirpcError && e.code === 'unavailable');
  client.close();
});

test('call: token() is called for each new connection, and the next call reopens', async () => {
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, (m) => ({ id: (m as { id: number }).id, ok: true, result: 'ok' })); return c; },
    token: () => 'tok',
  });
  assert.equal(await client.call('health', {}), 'ok');
  await tick();
  sockets[0]?.destroy();
  await tick();
  assert.equal(await client.call('health', {}), 'ok', 'a new call reopens after a close');
  assert.equal(sockets.length, 2);
  client.close();
});

test('call: the current token is sent on each new connection', async () => {
  const got: Array<unknown> = [];
  let token = 'first';
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, (m) => { got.push((m as { token: unknown }).token); return { id: (m as { id: number }).id, ok: true, result: 'ok' }; }); return c; },
    token: () => token,
  });
  await client.call('health', {});
  await tick();
  token = 'second';
  sockets[0]?.destroy();
  await tick();
  await client.call('health', {});
  await tick();
  assert.deepEqual(got, ['first', 'second']);
  client.close();
});

test('stream: up, snapshot messages, and down once on a drop', async () => {
  const states: string[] = [];
  const messages: Array<{ project_id: string; seq: number; snapshot: unknown }> = [];
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, (m) => ({ id: (m as { id: number }).id, ok: true, result: { subscribed: ['p1'] } })); return c; },
    token: () => 'tok',
  });
  const stop = client.stream((m) => messages.push(m), (s) => states.push(s));
  await tick();
  assert.deepEqual(states, ['up']);
  sockets[0]?.write(`${JSON.stringify({ stream: 1, project_id: 'p1', seq: 7, snapshot_patch: { op: 'replace', value: { head_seq: 7 } } })}\n`);
  await tick();
  assert.deepEqual(messages, [{ project_id: 'p1', seq: 7, snapshot: { head_seq: 7 } }]);
  sockets[0]?.destroy();
  await tick();
  assert.deepEqual(states, ['up', 'down']);
  stop();
  client.close();
});

test('stream: reconnects after backoffMs and reports up again', async () => {
  const states: string[] = [];
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, (m) => ({ id: (m as { id: number }).id, ok: true, result: {} })); return c; },
    token: () => 'tok',
    backoffMs: [5],
  });
  const stop = client.stream(() => {}, (s) => states.push(s));
  await tick();
  assert.deepEqual(states, ['up']);
  sockets[0]?.destroy();
  await tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(states, ['up', 'down', 'up']);
  assert.ok(sockets.length >= 2, 'it opened a new connection');
  stop();
  // No reconnect after stop.
  const n = sockets.length;
  const before = states.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sockets.length, n, 'stopped streams stay stopped');
  assert.equal(states.length, before);
  client.close();
});

test('stream: a connection that closes before any up reports down once', async () => {
  const states: string[] = [];
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, () => undefined); return c; },
    token: () => 'tok',
    backoffMs: [1000],
  });
  const stop = client.stream(() => {}, (s) => states.push(s));
  await tick();
  assert.deepEqual(states, [], 'no up yet, so nothing reported');
  sockets[0]?.destroy();
  await tick();
  assert.deepEqual(states, ['down'], 'a connection that never came up still reports the drop');
  stop();
  client.close();
});

test('stream: a bad line is ignored, a reply with no ok:true is not an up', async () => {
  const states: string[] = [];
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, (m) => ({ id: (m as { id: number }).id, ok: false, error: { code: 'forbidden', message: 'no' } })); return c; },
    token: () => 'tok',
    backoffMs: [1000],
  });
  const stop = client.stream(() => {}, (s) => states.push(s));
  await tick();
  sockets[0]?.write('not json\n');
  await tick();
  assert.deepEqual(states, []);
  stop();
  client.close();
});

test('stream: a line over 4 MB with no newline destroys that connection', async () => {
  const sockets: Wire[] = [];
  const client = new UirpcClient({
    connect: () => { const [c, s] = pair(); sockets.push(s); serve(s, (m) => ({ id: (m as { id: number }).id, ok: true, result: {} })); return c; },
    token: () => 'tok',
    backoffMs: [10000],
  });
  client.stream(() => {}, () => {});
  await tick();
  sockets[0]?.write('x'.repeat(4 * 1024 * 1024 + 1));
  await tick();
  await tick();
  assert.ok(sockets[0]?.destroyed, 'the client destroyed the oversized connection');
  client.close();
});

test('close(): a call after close is unavailable', async () => {
  const client = new UirpcClient({ connect: () => pair()[0], token: () => 'tok' });
  client.close();
  await assert.rejects(client.call('health', {}), (e: unknown) => e instanceof UirpcError && e.code === 'unavailable');
});
