// The S3 example, end to end (roadmap 0B exit criterion 1; coordination.md §2):
//   1. A reads src/types.ts at hash ABC.
//   2. B changes it and finishes, and the human lands it.
//   3. A's branch is synced at turn end, and A is told "Dependency changed: src/types.ts has changed since
//      you read it." with a diff excerpt.
// Everything is real but the model: the coordination server, harnessd, two Claude Code agents on the
// pinned CLI (the scripted mock plays the model), Git, srt, and the `harness land` CLI. The land runs the
// repo's test command, which starts a server on 127.0.0.1, under srt (D-83).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../packages/daemon/src/approvals.ts';
import { gitIn } from '../packages/daemon/test/fixtures.ts';
import { startStack, steps, type Stack } from './support.ts';

const TYPES_BEFORE = 'export type User = { id: string };\n';
const TYPES_AFTER = 'export type User = { id: string; email: string };\n';
// The repo's own test: a server on loopback, which the land's sandbox must allow (D-83).
const LOOPBACK_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
test('serves on loopback', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const res = await fetch(\`http://127.0.0.1:\${server.address().port}/\`);
  assert.equal(await res.text(), 'ok');
  server.close();
});
`;

let s: Stack;
let approver: NodeJS.Timeout;
const approved: string[] = [];
before(async () => {
  s = await startStack({
    portRange: [31600, 31699],
    files: {
      'src/types.ts': TYPES_BEFORE,
      'src/web/Login.tsx': 'export {}\n',
      'package.json': '{"name":"s3","type":"module"}\n',
      'test/server.test.mjs': LOOPBACK_TEST,
      'harness.yaml': 'test:\n  command: node --test test/server.test.mjs\n  manifests: [package.json]\n',
    },
  });
  // The human approves the repo's test command when the land first asks (D-52); the demo does the same.
  approver = setInterval(() => {
    const a = new Approvals(s.home);
    for (const r of a.pending()) { approved.push(`${r.kind ?? 'setup'}:${r.command}`); a.approve(r.id); }
  }, 100);
});
after(async () => {
  clearInterval(approver);
  await s?.stop();
});

const dataOf = (e: { data: unknown }) => e.data as Record<string, any>;

test('S3: A reads src/types.ts; B changes it and it lands; A is synced at turn end and told, with a diff', async () => {
  const frontend = (await s.command('agent.create', { name: 'agent/frontend', vendor: 'claude' })).agent_id!;
  const backend = (await s.command('agent.create', { name: 'agent/backend', vendor: 'claude' })).agent_id!;
  const baseBlob = gitIn(s.repo, 'rev-parse', `${s.sha}:src/types.ts`);

  // 1. A reads src/types.ts, then ends its turn. Its later turns: the in-progress notice, then the landed one (re-read, done).
  const tA = await s.nextTaskId();
  const wtA = s.worktreeOf(tA);
  assert.equal(await s.assignTask(frontend, 'Login page', ['src/web/'], steps(
    `Read {"file_path":"${wtA}/src/types.ts"}`,
    'TEXT ready',
    'TEXT noted: someone is changing types.ts',
    `Read {"file_path":"${wtA}/src/types.ts"}`,
    'TEXT re-read after the sync',
  )), tA);
  await s.turnEnds(tA, 1, 60_000);
  const firstRead = await s.nextEvent((e) => e.kind === 'readset.added' && dataOf(e).task_id === tA && dataOf(e).entries.some((x: any) => x.path === 'src/types.ts'), 30_000);
  assert.equal(dataOf(firstRead).entries.find((x: any) => x.path === 'src/types.ts').hash, baseBlob, 'A read the base content: its Git blob id');

  // 2. B changes it: A hears about the change in progress (awareness only).
  const tB = await s.nextTaskId();
  const wtB = s.worktreeOf(tB);
  assert.equal(await s.assignTask(backend, 'Login API', ['src/types.ts'], steps(
    `Read {"file_path":"${wtB}/src/types.ts"}`,
    `Edit {"file_path":"${wtB}/src/types.ts","old_string":"{ id: string }","new_string":"{ id: string; email: string }"}`,
    'mcp__harness__report_done {"summary":"Add email to User"}',
    'TEXT done',
  )), tB);
  const inProgress = await s.nextEvent((e) => e.kind === 'message.delivered' && dataOf(e).kind === 'dependency_changed' && dataOf(e).to_task_id === tA, 60_000);
  assert.ok(inProgress);
  const ipMsg = s.daemon.view(s.project).messages.get(dataOf(inProgress).message_id)!;
  assert.equal(ipMsg.data.stage, 'in_progress');
  assert.match(ipMsg.text, /^src\/types\.ts: agent\/backend \(task T-\d+\) is changing this file, which you read at hash [0-9a-f]{7}\./);

  // B finishes; harnessd commits its work.
  await s.nextEvent((e) => e.kind === 'worktree.committed' && dataOf(e).task_id === tB, 90_000);
  await s.turnEnds(tA, 2, 60_000);

  // The human lands B's task with the real CLI: merge, approved tests (loopback server under srt), fast-forward.
  const out = await s.cli('land', tB);
  assert.match(out, /Landed T-\d+: the base is now [0-9a-f]{12}/, out);
  assert.deepEqual(approved, ['test:node --test test/server.test.mjs'], 'the test command was approved as a test, separately from setup');

  // 3. A is synced at its turn end (it was idle: at once), then told, with a diff excerpt.
  await s.turnEnds(tA, 3, 60_000);
  const events = s.daemon.view(s.project).events;
  const seq = (pred: (e: (typeof events)[number]) => boolean) => events.find(pred)?.seq ?? -1;
  const accepted = seq((e) => e.kind === 'land.accepted' && dataOf(e).task_id === tB);
  const completed = seq((e) => e.kind === 'land.completed' && dataOf(e).task_id === tB);
  const synced = seq((e) => e.kind === 'worktree.synced' && dataOf(e).task_id === tA);
  const landedMsg = [...s.daemon.view(s.project).messages.values()].find((m) => m.toTask === tA && m.data.stage === 'landed')!;
  assert.ok(landedMsg, 'a landed notice for A');
  const told = seq((e) => e.kind === 'message.delivered' && dataOf(e).message_id === landedMsg.id);
  assert.ok(accepted > 0 && accepted < completed && completed < synced && synced < told, `order: accepted ${accepted} < completed ${completed} < synced ${synced} < delivered ${told}`);
  assert.deepEqual(dataOf(events.find((e) => e.seq === synced)!).stale_paths, ['src/types.ts'], "A's read is stale until it reads it again");

  // What A's model actually received.
  const atA = JSON.stringify(s.mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary).includes(landedMsg.id)).at(-1)!.summary);
  assert.ok(atA.includes('Dependency changed: src/types.ts has changed since you read it.'), 'the exact S3 sentence');
  assert.ok(atA.includes('+export type User = { id: string; email: string };'), 'with a diff excerpt of the landed change');
  assert.ok(atA.includes('-export type User = { id: string };'));

  // The base moved by fast-forward, and the human's checkout followed; A's branch has it.
  const landed = dataOf(events.find((e) => e.seq === completed)!);
  assert.equal(gitIn(s.repo, 'rev-parse', 'main'), landed.new_base_sha);
  assert.equal(fs.readFileSync(path.join(s.repo, 'src/types.ts'), 'utf8'), TYPES_AFTER);
  execFileSync('git', ['-C', wtA, 'merge-base', '--is-ancestor', landed.new_base_sha, 'HEAD']);
  assert.equal(fs.readFileSync(path.join(wtA, 'src/types.ts'), 'utf8'), TYPES_AFTER);

  // A's claims never include the peer's file the sync brought in; its read entry is fresh again, at the new hash.
  assert.ok(!(s.daemon.view(s.project).claims.get(tA)?.observed.has('src/types.ts')));
  const newBlob = gitIn(s.repo, 'rev-parse', `${landed.new_base_sha}:src/types.ts`);
  const entry = (await s.db.pool.query("SELECT content_hash, stale FROM read_entries WHERE task_id = $1 AND path = 'src/types.ts'", [tA])).rows[0];
  assert.deepEqual(entry, { content_hash: newBlob, stale: false }, 'A re-read the landed content');

  // B is landed: its worktree is gone; the land's metrics are in the log.
  assert.equal((await s.db.pool.query('SELECT status FROM tasks WHERE id = $1', [tB])).rows[0].status, 'landed');
  assert.ok(!fs.existsSync(s.worktreeOf(tB)));
  await s.daemon.stopAgent(tA);
});
