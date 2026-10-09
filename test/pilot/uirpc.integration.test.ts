// The UI's path through harnessd (D-117): the bridge's socket against a real harnessd in the pilot stack. A task's
// derived state, the publish approval shown and granted through the socket, and a human command sent through it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ProjectSnapshot } from '../../packages/protocol/src/index.ts';
import { startPilotStack } from '../support.ts';

async function rpcClient(socket: string) {
  const token = fs.readFileSync(path.join(path.dirname(socket), 'uirpc.token'), 'utf8').trim();
  const c = net.connect(socket);
  await new Promise<void>((r, j) => { c.once('connect', () => r()); c.once('error', j); });
  const replies = new Map<number, { ok: boolean; result?: unknown; error?: { code: string; message: string } }>();
  let buf = '';
  c.setEncoding('utf8');
  c.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (typeof m.id === 'number') replies.set(m.id, m); } });
  let n = 0;
  return {
    close: () => c.end(),
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = ++n;
      c.write(`${JSON.stringify({ id, token, method, params })}\n`);
      for (const end = Date.now() + 10_000; !replies.has(id); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error(`no reply to ${method}`);
      const r = replies.get(id)!;
      if (!r.ok) throw new Error(`${r.error!.code}: ${r.error!.message}`);
      return r.result as T;
    },
  };
}

test('through the socket: a running task\'s state, its publish approved as shown, and a human\'s message', async () => {
  const short = fs.mkdtempSync('/tmp/hui-'); // macOS caps socket paths at 104 bytes
  const socket = path.join(short, 'run', 'harnessd.sock');
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, sideOptions: { a: { uiSocket: socket, uiPollMs: 50 } } });
  try {
    const ui = await rpcClient(socket);
    const state = async (task: string) => (await ui.call<ProjectSnapshot[]>('snapshot', { project_id: s.project }))[0]!.tasks.find((t) => t.id === task)?.state;
    const agent = (await s.a.command('agent.create', { name: 'agent/ui', vendor: 'claude' })).agent_id!;
    const task = await s.a.assign(agent, { title: 'ui work', text: 'do it', scope: [] });
    await s.until(() => s.a.daemon.running.has(task), 20_000, 'the session');
    for (const end = Date.now() + 10_000; (await state(task)) !== 'running';) if (Date.now() > end) assert.fail(`state ${await state(task)}`);
    fs.writeFileSync(path.join(s.a.daemon.worktreeOf(s.project, task), 'ui.txt'), 'hi\n');
    await s.a.signed('task.complete', { task_id: task });
    // The publish request, as the UI shows it, then approved with the hash it showed.
    type Pending = { id: string; kind: string; task_id: string; command: string; hash: string };
    let req: Pending | undefined;
    for (const end = Date.now() + 20_000; !req; await new Promise((r) => setTimeout(r, 50))) {
      req = (await ui.call<Pending[]>('pending_approvals')).find((r) => r.kind === 'publish' && r.task_id === task);
      if (Date.now() > end) assert.fail('no publish request');
    }
    assert.equal(await state(task), 'publish_pending_approval');
    assert.match(req.command, /ui\.txt/);
    await ui.call('approve', { id: req.id, shown_hash: req.hash });
    for (const end = Date.now() + 20_000; (await state(task)) !== 'pr_open';) if (Date.now() > end) assert.fail(`state ${await state(task)}`);
    assert.equal(s.fake.prs().length, 1);
    // A human's question through the socket reaches the coordinator as this human, and B's view.
    const r = await ui.call<{ seqs: number[] }>('command', { project_id: s.project, name: 'message.send', args: { kind: 'question', to: 'agent/ui', text: 'hello from the UI' }, command_id: randomUUID() });
    assert.equal(r.seqs.length, 1);
    await s.until(() => [...s.b.daemon.view(s.project).messages.values()].some((m) => m.text === 'hello from the UI' && m.from === 'human_a'), 10_000, 'the note at B');
    ui.close();
  } finally {
    await s.stop();
    fs.rmSync(short, { recursive: true, force: true });
  }
});

test('through the socket: a human\'s lifecycle commands, signed by harnessd: start, complete, then integrate what was shown', async () => {
  const short = fs.mkdtempSync('/tmp/hui-');
  const socket = path.join(short, 'run', 'harnessd.sock');
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, sideOptions: { a: { uiSocket: socket, uiPollMs: 50 } } });
  try {
    const ui = await rpcClient(socket);
    const dispatch = (kind: string, task: string, more: Record<string, unknown> = {}) =>
      ui.call<{ seqs: number[]; result: unknown }>('dispatch', { project_id: s.project, kind, task_id: task, command_id: randomUUID(), ...more });
    const agent = (await s.a.command('agent.create', { name: 'agent/ui2', vendor: 'claude' })).agent_id!;
    const created = await ui.call<{ result: { task_id: string } }>('command', { project_id: s.project, name: 'task.create', args: { title: 'notes', text: 'Add notes.', scope: [] }, command_id: randomUUID() });
    const task = created.result.task_id;
    await s.until(() => s.a.daemon.view(s.project).tasks.has(task), 10_000, 'the task in A\'s view');
    await dispatch('start', task, { agent_id: agent });
    await s.until(() => s.a.daemon.running.has(task), 20_000, 'the session');
    const started = s.a.acted.find((e) => e.kind === 'task.assigned' && (e.data as { task_id: string }).task_id === task)!;
    assert.equal((started.data as { dispatch: { envelope: { issuer_device_id: string } } }).dispatch.envelope.issuer_device_id, 'dev_a', 'signed by this device');
    fs.writeFileSync(path.join(s.a.daemon.worktreeOf(s.project, task), 'notes.md'), 'notes\n');
    await dispatch('complete', task, { summary: 'Added notes.' });
    type Pending = { id: string; kind: string; task_id: string; hash: string };
    let req: Pending | undefined;
    for (const end = Date.now() + 20_000; !req; await new Promise((r) => setTimeout(r, 50))) {
      req = (await ui.call<Pending[]>('pending_approvals')).find((r) => r.kind === 'publish' && r.task_id === task);
      if (Date.now() > end) assert.fail('no publish request');
    }
    await ui.call('approve', { id: req.id, shown_hash: req.hash });
    await s.until(() => s.a.daemon.view(s.project).prs.has(task), 20_000, 'the PR');
    const pr = s.a.daemon.view(s.project).prs.get(task)!;
    // What the human was shown must still be true on GitHub: a stale base is refused before anything is sent.
    await assert.rejects(dispatch('integrate', task, { expected: { pr_number: pr.prNumber, head_sha: pr.headSha, base_sha: 'b'.repeat(40) } }), /conflict: main is now [0-9a-f]{12}, not the bbbbbbbbbbbb you approved/);
    await dispatch('integrate', task, { expected: { pr_number: pr.prNumber, head_sha: pr.headSha, base_sha: pr.baseSha } });
    await s.until(() => s.a.daemon.view(s.project).tasks.get(task)?.status === 'landed', 30_000, 'the land');
    assert.equal(s.fake.log.filter((l) => l.method === 'PUT' && l.path.endsWith('/merge')).length, 1, 'one merge');
    ui.close();
  } finally {
    await s.stop();
    fs.rmSync(short, { recursive: true, force: true });
  }
});
