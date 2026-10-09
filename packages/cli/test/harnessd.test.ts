// The CLI asks this Mac's harnessd to sign lifecycle dispatches (PB2b; D-112, D-117): over the owner-only socket, with
// its token. Every failure says what to do, a conflict says the task changed, and nothing harnessd says is printed raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { harnessHome } from '@harness/daemon';
import { dispatchVia, harnessd } from '../src/harnessd.ts';
import { CliError } from '../src/client.ts';

/** A fake harnessd socket (a short path: macOS caps socket paths at 104 bytes) that answers with `reply`. */
async function fake(reply: (req: Record<string, unknown>) => unknown) {
  const root = fs.mkdtempSync('/tmp/hcli-');
  const home = harnessHome(root);
  const run = path.join(root, 'run');
  fs.mkdirSync(run, { mode: 0o700 });
  fs.writeFileSync(path.join(run, 'uirpc.token'), 'tok-123\n', { mode: 0o600 });
  const seen: Record<string, unknown>[] = [];
  const server = net.createServer((c) => {
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d: string) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      seen.push(req);
      const r = reply(req);
      if (r !== undefined) c.write(`${typeof r === 'string' ? r : JSON.stringify(r)}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(path.join(run, 'harnessd.sock'), r));
  return { home, root, seen, close: () => new Promise<void>((r) => server.close(() => { fs.rmSync(root, { recursive: true, force: true }); r(); })) };
}
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e) => e instanceof CliError && re.test(e.message) || assert.fail(String(e)));

test('a dispatch goes to harnessd with its token, kind, args, what the human saw, and a command id', async () => {
  const f = await fake((req) => ({ id: req.id, ok: true, result: { seqs: [7], result: null } }));
  try {
    const out = await dispatchVia(f.home, {
      project_id: 'prj_a', kind: 'start', task_id: 'T-1', args: { assignee_agent_id: 'agent_x' }, expected: { task_sha256: 'a'.repeat(64) }, command_id: '6f0e…',
    });
    assert.deepEqual(out, { seqs: [7], result: null });
    const [req] = f.seen;
    assert.equal(req!.token, 'tok-123');
    assert.equal(req!.method, 'dispatch');
    assert.deepEqual(req!.params, { project_id: 'prj_a', kind: 'start', task_id: 'T-1', args: { assignee_agent_id: 'agent_x' }, expected: { task_sha256: 'a'.repeat(64) }, command_id: '6f0e…' });
  } finally { await f.close(); }
});

test('harnessd\'s refusals become errors that say what to do, with its text sanitized', async () => {
  const replies: unknown[] = [
    { ok: false, error: { code: 'conflict', message: 'task T-1 changed\u001b[2J' } },
    { ok: false, error: { code: 'unauthorized', message: 'bad token' } },
    { ok: false, error: { code: 'not_available', message: 'signed dispatch arrives with PA3' } },
    'not json',
  ];
  const f = await fake((req) => { const r = replies.shift(); return typeof r === 'object' ? { id: req.id, ...r } : r; });
  try {
    await rejects(harnessd(f.home, 'dispatch', {}), /^it changed since you looked: task T-1 changed \[2J\. Look again/);
    await rejects(harnessd(f.home, 'dispatch', {}), /refused the CLI's token/);
    await rejects(harnessd(f.home, 'dispatch', {}), /can't sign that yet: signed dispatch arrives with PA3/);
    await rejects(harnessd(f.home, 'dispatch', {}), /isn't JSON/);
  } finally { await f.close(); }
});

test('no harnessd, a token others can read, or no answer: each says so', async () => {
  const f = await fake(() => undefined); // never answers
  try {
    await rejects(harnessd(f.home, 'health', {}, 300), /didn't answer health/);
    fs.chmodSync(path.join(f.root, 'run', 'uirpc.token'), 0o644);
    await rejects(harnessd(f.home, 'health', {}), /must be owner-only/);
  } finally { await f.close(); }
  const empty = harnessHome(fs.mkdtempSync('/tmp/hcli-'));
  try {
    await rejects(harnessd(empty, 'health', {}), /harnessd isn't running on this Mac \(no uirpc token\)/);
    fs.mkdirSync(path.join(empty.root, 'run'), { mode: 0o700 });
    fs.writeFileSync(path.join(empty.root, 'run', 'uirpc.token'), 'x\n', { mode: 0o600 });
    await rejects(harnessd(empty, 'health', {}), /its socket is gone/);
  } finally { fs.rmSync(empty.root, { recursive: true, force: true }); }
});
