// harnessd's RPC for the UI bridge (D-117; protocol.md §12): an owner-only socket and a per-start token; approvals
// bound to what was shown; an allowlist of commands; snapshots streamed as they change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Approvals } from '../src/approvals.ts';
import { UiRpc } from '../src/uirpc.ts';
import { tempDir, tempHome } from './fixtures.ts';

/** A client: sends one line per request, collects every line it gets back. */
async function client(socket: string) {
  const c = net.connect(socket);
  await new Promise<void>((r, j) => { c.once('connect', () => r()); c.once('error', j); });
  const lines: Record<string, unknown>[] = [];
  let buf = '';
  let closed = false;
  c.setEncoding('utf8');
  c.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  c.on('close', () => { closed = true; });
  let n = 0;
  const until = async (pred: () => boolean, what: string) => {
    for (const end = Date.now() + 5000; !pred(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  };
  return {
    c, lines, closed: () => closed, until,
    async call(token: string, method: string, params: Record<string, unknown> = {}) {
      const id = ++n;
      c.write(`${JSON.stringify({ id, token, method, params })}\n`);
      await until(() => lines.some((l) => l.id === id) || closed, `reply ${id}`);
      return lines.find((l) => l.id === id) as { ok: boolean; result?: unknown; error?: { code: string; message: string } } | undefined;
    },
  };
}

async function rpc() {
  const t = tempDir('uirpc');
  const home = tempHome(t.dir);
  const short = fs.mkdtempSync('/tmp/hui-'); // macOS caps socket paths at 104 bytes
  const socket = path.join(short, 'run', 'harnessd.sock');
  const approvals = new Approvals(home);
  const commands: unknown[][] = [];
  const resets: number[] = [];
  const dispatches: unknown[][] = [];
  let seq = 1;
  const snapshot = (p: string) => ({ v: 1, project_id: p, head_seq: seq, taken_at: new Date().toISOString(), tasks: [] }) as never;
  const server = new UiRpc({
    socket, pollMs: 20,
    host: {
      projects: () => ['prj_a'], snapshot, health: () => ({ connection: 'connected' }), approvals,
      command: async (...args) => { commands.push(args); return { seqs: [7], result: { task_id: 'T-9' } }; }, log: () => {},
      resetProvider: () => { resets.push(1); },
      dispatch: async (...args) => {
        dispatches.push(args);
        if (args[2] === 'T-404') throw Object.assign(new Error('no task T-404 in prj_a'), { code: 'not_found' });
        return { seqs: [8], result: null };
      },
    },
  });
  await server.start();
  const token = fs.readFileSync(path.join(short, 'run', 'uirpc.token'), 'utf8').trim();
  return {
    t, home, socket, approvals, commands, resets, dispatches, server, token, bump: () => { seq++; },
    async stop() { await server.stop(); t.cleanup(); fs.rmSync(short, { recursive: true, force: true }); },
  };
}

test('owner-only: a 0700 directory, a 0600 socket and token; a wrong token closes the connection; junk crashes nothing', async () => {
  const r = await rpc();
  try {
    assert.equal(fs.statSync(path.dirname(r.socket)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(r.socket).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(path.dirname(r.socket), 'uirpc.token')).mode & 0o777, 0o600);
    const bad = await client(r.socket);
    assert.deepEqual((await bad.call('x'.repeat(64), 'snapshot'))!.error, { code: 'unauthorized', message: 'bad token' });
    await bad.until(() => bad.closed(), 'the close');
    const junk = await client(r.socket);
    junk.c.write('not json\n');
    await junk.until(() => junk.closed(), 'the close');
    const ok = await client(r.socket);
    assert.equal((await ok.call(r.token, 'health'))!.ok, true, 'still serving');
    ok.c.end();
  } finally { await r.stop(); }
});

test('approvals: listed with what the human must see; approved only with the exact id and the hash shown; denied', async () => {
  const r = await rpc();
  try {
    const hash = 'a'.repeat(64);
    r.approvals.request({ projectId: 'prj_a', taskId: 'T-1', command: 'npm ci', manifests: [], hash, kind: 'setup' });
    const other = r.approvals.request({ projectId: 'prj_a', taskId: 'T-2', command: 'publish T-2', manifests: [], hash: 'b'.repeat(64), kind: 'publish' });
    const c = await client(r.socket);
    const listed = (await c.call(r.token, 'pending_approvals'))!.result as { id: string; kind: string; command: string; hash: string }[];
    assert.deepEqual(listed.map((x) => [x.kind, x.command]), [['setup', 'npm ci'], ['publish', 'publish T-2']]);
    const id = listed[0]!.id;
    assert.equal((await c.call(r.token, 'approve', { id, shown_hash: 'c'.repeat(64) }))!.error!.code, 'conflict', 'not what was shown');
    assert.equal((await c.call(r.token, 'approve', { id: id.slice(0, 4), shown_hash: hash }))!.error!.code, 'not_found', 'never a prefix');
    assert.deepEqual((await c.call(r.token, 'approve', { id, shown_hash: hash }))!.result, { approved: id });
    assert.equal(r.approvals.isApproved('prj_a', hash), true);
    assert.deepEqual((await c.call(r.token, 'deny', { id: other.id }))!.result, { denied: other.id });
    assert.equal(r.approvals.isApproved('prj_a', other.hash), false);
    assert.deepEqual(r.approvals.pending(), []);
    c.c.end();
  } finally { await r.stop(); }
});

test('commands: an allowlist, no assignment without a dispatch, a UUID command id; a dispatch goes to harnessd to sign', async () => {
  const r = await rpc();
  try {
    const c = await client(r.socket);
    const id = '0d4f5a3e-6b8c-4a1d-9e2f-3c4b5a6d7e8f';
    assert.equal((await c.call(r.token, 'command', { project_id: 'prj_a', name: 'task.assign', args: {}, command_id: id }))!.error!.code, 'forbidden');
    assert.equal((await c.call(r.token, 'command', { project_id: 'prj_a', name: 'task.create', args: { title: 'x', assignee_agent_id: 'agent_x' }, command_id: id }))!.error!.code, 'forbidden');
    assert.equal((await c.call(r.token, 'command', { project_id: 'prj_a', name: 'task.create', args: { title: 'x' }, command_id: 'nope' }))!.error!.code, 'bad_request');
    assert.equal((await c.call(r.token, 'command', { project_id: 'prj_other', name: 'task.create', args: { title: 'x' }, command_id: id }))!.error!.code, 'not_found');
    assert.deepEqual((await c.call(r.token, 'command', { project_id: 'prj_a', name: 'task.create', args: { title: 'x', text: 'y' }, command_id: id }))!.result, { seqs: [7], result: { task_id: 'T-9' } });
    assert.deepEqual(r.commands, [['prj_a', 'task.create', { title: 'x', text: 'y' }, id]]);
    // A lifecycle command is a dispatch: harnessd builds and signs it (D-112). The socket checks its shape and passes it on.
    assert.equal((await c.call(r.token, 'dispatch', { project_id: 'prj_a', kind: 'merge', task_id: 'T-1', command_id: id }))!.error!.code, 'bad_request');
    assert.equal((await c.call(r.token, 'dispatch', { project_id: 'prj_a', kind: 'start', task_id: 'T-1', command_id: 'nope' }))!.error!.code, 'bad_request');
    assert.equal((await c.call(r.token, 'dispatch', { project_id: 'prj_a', kind: 'reopen', task_id: 'T-1', text: 7, command_id: id }))!.error!.code, 'bad_request');
    const expected = { pr_number: 4, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) };
    assert.deepEqual((await c.call(r.token, 'dispatch', { project_id: 'prj_a', kind: 'integrate', task_id: 'T-1', expected, command_id: id }))!.result, { seqs: [8], result: null });
    assert.deepEqual((await c.call(r.token, 'dispatch', { project_id: 'prj_a', kind: 'start', task_id: 'T-2', agent_id: 'agent_x', command_id: id }))!.result, { seqs: [8], result: null });
    assert.deepEqual(r.dispatches, [['prj_a', 'integrate', 'T-1', { expected }, id], ['prj_a', 'start', 'T-2', { agentId: 'agent_x' }, id]]);
    assert.equal((await c.call(r.token, 'dispatch', { project_id: 'prj_a', kind: 'abandon', task_id: 'T-404', command_id: id }))!.error!.code, 'not_found', 'a refusal keeps its code');
    assert.deepEqual((await c.call(r.token, 'provider_reset'))!.result, { reset: true });
    assert.deepEqual(r.resets, [1]);
    assert.equal((await c.call(r.token, 'nope'))!.error!.code, 'bad_request');
    c.c.end();
  } finally { await r.stop(); }
});

test('snapshots: on request, and streamed: the current one at once, then each change, never a repeat', async () => {
  const r = await rpc();
  try {
    const c = await client(r.socket);
    const snaps = (await c.call(r.token, 'snapshot'))!.result as { project_id: string }[];
    assert.deepEqual(snaps.map((s) => s.project_id), ['prj_a']);
    assert.deepEqual((await c.call(r.token, 'events'))!.result, { subscribed: ['prj_a'] });
    const streamed = () => c.lines.filter((l) => l.stream !== undefined) as { seq: number; snapshot_patch: { op: string; value: { head_seq: number } } }[];
    await c.until(() => streamed().length === 1, 'the current snapshot');
    await new Promise((res) => setTimeout(res, 100)); // five poll rounds with no change: nothing more is sent
    assert.equal(streamed().length, 1);
    r.bump();
    await c.until(() => streamed().length === 2, 'the change');
    assert.deepEqual([streamed()[1]!.seq, streamed()[1]!.snapshot_patch.op, streamed()[1]!.snapshot_patch.value.head_seq], [2, 'replace', 2]);
    c.c.end();
  } finally { await r.stop(); }
});

test('a stale socket from a crash is replaced; anything else at that path is refused', async () => {
  const short = fs.mkdtempSync('/tmp/hui-');
  const t = tempDir('uirpc-stale');
  try {
    const socket = path.join(short, 'run', 'harnessd.sock');
    fs.mkdirSync(path.dirname(socket), { recursive: true });
    // A harnessd that died listening (SIGKILL): its socket file stays behind.
    const dead = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => console.log("up"))', socket], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((res) => dead.stdout!.once('data', res));
    dead.kill('SIGKILL');
    await new Promise((res) => dead.once('exit', res));
    assert.ok(fs.lstatSync(socket).isSocket(), 'the stale socket is there');
    const host = { projects: () => [], snapshot: () => ({}) as never, health: () => ({ up: true }), approvals: new Approvals(tempHome(t.dir)), command: async () => ({ seqs: [], result: null }), log: () => {}, resetProvider: () => {}, dispatch: async () => ({ seqs: [], result: null }) };
    const r = new UiRpc({ socket, host });
    await r.start();
    const token = fs.readFileSync(path.join(short, 'run', 'uirpc.token'), 'utf8').trim();
    const c = await client(socket);
    assert.deepEqual((await c.call(token, 'health'))!.result, { up: true });
    c.c.end();
    await r.stop();
    assert.ok(!fs.existsSync(socket) && !fs.existsSync(path.join(short, 'run', 'uirpc.token')), 'stop removes both');
    fs.writeFileSync(socket, 'not a socket');
    await assert.rejects(new UiRpc({ socket, host }).start(), /isn't a socket/);
  } finally { fs.rmSync(short, { recursive: true, force: true }); t.cleanup(); }
});
