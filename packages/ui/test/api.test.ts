// The UI's API client (D-117; protocol.md §12). Every test runs against a stub fetch and stub browser globals, so
// nothing here opens a connection or listens on a port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, api } from '../web/api.ts';

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string | null; signal?: AbortSignal };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function jsonResponse(status: number, body: unknown): unknown {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** A streaming response whose reader yields each line once, encoded, then ends — unless `hold` keeps it open. */
function streamResponse(lines: string[], status = 200, opts: { hold?: boolean } = {}): unknown {
  const enc = new TextEncoder();
  let i = 0;
  const body = {
    getReader: () => ({
      read: async () => {
        if (i < lines.length) return { value: enc.encode(lines[i++]!), done: false };
        if (opts.hold) return new Promise<never>(() => {});
        return { value: undefined, done: true };
      },
    }),
  };
  return { status, ok: status >= 200 && status < 300, body };
}

/** Installs the browser globals api.ts reads, and records what the client sends. */
function env(init: { hash?: string; token?: string } = {}) {
  const g = globalThis as Record<string, unknown>;
  const calls: FetchCall[] = [];
  const store = new Map<string, string>();
  if (init.token !== undefined) store.set('harness.session', init.token);
  const historyCalls: unknown[][] = [];
  let responder: (call: FetchCall) => unknown = () => jsonResponse(200, { result: null });

  g.sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  g.location = { hash: init.hash ?? '' };
  g.history = { replaceState: (...args: unknown[]) => { historyCalls.push(args); } };
  g.fetch = (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    const call: FetchCall = { url, method: opts?.method ?? 'GET', headers: opts?.headers ?? {}, body: opts?.body ?? null, signal: opts?.signal };
    calls.push(call);
    return Promise.resolve(responder(call));
  };

  return {
    calls, store, historyCalls,
    setResponder: (r: (call: FetchCall) => unknown) => { responder = r; },
    cleanup: () => { delete g.sessionStorage; delete g.location; delete g.history; delete g.fetch; },
  };
}

test('startSession swaps the launch fragment for a session token and clears it', async () => {
  const e = env({ hash: '#t=launch-tok' });
  e.setResponder(() => jsonResponse(200, { session_token: 'sess-1' }));
  await api.startSession();
  assert.equal(e.calls.length, 1);
  const call = e.calls[0]!;
  assert.equal(call.url, '/api/session');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.body!), { launch_token: 'launch-tok' });
  assert.equal(e.store.get('harness.session'), 'sess-1');
  assert.equal(api.hasSession(), true);
  assert.deepEqual(e.historyCalls, [[null, '', '/#/']], 'the fragment is cleared from history');
  e.cleanup();
});

test('calls carry the bearer token and read back the result', async () => {
  const e = env({ token: 'sess-9' });
  e.setResponder(() => jsonResponse(200, { result: [{ project_id: 'prj_1' }] }));
  const list = await api.snapshot();
  assert.deepEqual(list, [{ project_id: 'prj_1' }]);
  const call = e.calls[0]!;
  assert.equal(call.method, 'GET');
  assert.equal(call.url, '/api/snapshot');
  assert.equal(call.headers['Authorization'], 'Bearer sess-9');
  assert.equal(call.body, null);
  e.cleanup();
});

test('command and dispatch send their fields as a JSON body', async () => {
  const e = env({ token: 't' });
  e.setResponder(() => jsonResponse(200, { result: { seqs: [4], result: { ok: true } } }));
  const sent = await api.command('prj_1', 'message.send', { text: 'hi' }, 'c1');
  assert.deepEqual(sent, { seqs: [4], result: { ok: true } });
  const c = e.calls.at(-1)!;
  assert.equal(c.url, '/api/command');
  assert.deepEqual(JSON.parse(c.body!), { project_id: 'prj_1', name: 'message.send', args: { text: 'hi' }, command_id: 'c1' });

  await api.dispatch('prj_1', 'start', 'T-2', { assignee_agent_id: 'a1' }, { task_sha256: 'h' }, 'c2');
  const d = e.calls.at(-1)!;
  assert.equal(d.url, '/api/dispatch');
  assert.deepEqual(JSON.parse(d.body!), {
    project_id: 'prj_1', kind: 'start', task_id: 'T-2', args: { assignee_agent_id: 'a1' }, expected: { task_sha256: 'h' }, command_id: 'c2',
  });
  e.cleanup();
});

test('approve encodes the id and sends the shown hash', async () => {
  const e = env({ token: 't' });
  e.setResponder(() => jsonResponse(200, { result: {} }));
  await api.approve('a/b c', 'h1');
  const call = e.calls.at(-1)!;
  assert.equal(call.url, '/api/approvals/a%2Fb%20c');
  assert.deepEqual(JSON.parse(call.body!), { decision: 'approve', shown_hash: 'h1' });
  e.cleanup();
});

test('error mapping: the code and message from the body, or http_<status>', async () => {
  const e = env({ token: 't' });
  e.setResponder(() => jsonResponse(409, { error: { code: 'conflict', message: 'not what was shown' } }));
  await assert.rejects(api.approve('id-1', 'hash'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 409);
    assert.equal(err.code, 'conflict');
    assert.equal(err.message, 'not what was shown');
    return true;
  });
  e.setResponder(() => jsonResponse(500, {}));
  await assert.rejects(api.snapshot(), (err: unknown) => err instanceof ApiError && err.status === 500 && err.code === 'http_500');
  e.cleanup();
});

test('a 401 removes the token and reports session_expired', async () => {
  const e = env({ token: 'sess' });
  e.setResponder(() => jsonResponse(401, { error: { code: 'unauthorized', message: 'nope' } }));
  await assert.rejects(api.health(), (err: unknown) => err instanceof ApiError && err.status === 401 && err.code === 'session_expired');
  assert.equal(e.store.has('harness.session'), false);
  assert.equal(api.hasSession(), false);
  e.cleanup();
});

test('a fetch rejection is bridge_unreachable with status 0', async () => {
  const e = env({ token: 't' });
  (globalThis as Record<string, unknown>).fetch = () => Promise.reject(new Error('refused'));
  await assert.rejects(api.snapshot(), (err: unknown) => err instanceof ApiError && err.status === 0 && err.code === 'bridge_unreachable');
  e.cleanup();
});

test('stream: a snapshot and a harnessd state line, and a keepalive is ignored', async () => {
  const e = env({ token: 't' });
  e.setResponder(() => streamResponse(['{"harnessd":"up"}\n', '{"snapshot":{"head_seq":3}}\n', '{"keepalive":true}\n'], 200, { hold: true }));
  const snaps: unknown[] = [];
  const states: string[] = [];
  const stop = api.stream({ snapshot: (s) => snaps.push(s), state: (s) => states.push(s) });
  try {
    await sleep(20);
    assert.deepEqual(snaps, [{ head_seq: 3 }]);
    assert.deepEqual(states, ['live'], 'the first line means it is answering, and it is reported once');
  } finally {
    stop();
    e.cleanup();
  }
});

test('stream: harnessd down then up is reported', async () => {
  const e = env({ token: 't' });
  e.setResponder(() => streamResponse(['{"harnessd":"down"}\n', '{"snapshot":{"head_seq":1}}\n'], 200, { hold: true }));
  const states: string[] = [];
  const stop = api.stream({ snapshot: () => {}, state: (s) => states.push(s) });
  try {
    await sleep(20);
    assert.deepEqual(states, ['harnessd_down', 'live']);
  } finally {
    stop();
    e.cleanup();
  }
});

test('stream: the body ending reconnects after a delay, and a stopped stream does not', async () => {
  const e = env({ token: 't' });
  let n = 0;
  e.setResponder(() => (n++ === 0 ? streamResponse(['{"harnessd":"up"}\n']) : streamResponse([])));
  const states: string[] = [];
  const stop = api.stream({ snapshot: () => {}, state: (s) => states.push(s) });
  try {
    await sleep(20);
    assert.deepEqual(states, ['live', 'reconnecting']);
    assert.equal(e.calls.length, 1);
    await sleep(1150);
    assert.ok(e.calls.length >= 2, 'the first reconnect is after about a second');
    stop();
    const after = e.calls.length;
    await sleep(1100);
    assert.equal(e.calls.length, after, 'a stopped stream stays stopped');
  } finally {
    stop();
    e.cleanup();
  }
});

test('stream: a 401 clears the session and stops for good', async () => {
  const e = env({ token: 't' });
  e.setResponder(() => streamResponse([], 401));
  const states: string[] = [];
  const stop = api.stream({ snapshot: () => {}, state: (s) => states.push(s) });
  try {
    await sleep(20);
    assert.deepEqual(states, ['session_expired']);
    assert.equal(e.store.has('harness.session'), false);
    await sleep(1100);
    assert.equal(e.calls.length, 1, 'no retry after session_expired');
  } finally {
    stop();
    e.cleanup();
  }
});
