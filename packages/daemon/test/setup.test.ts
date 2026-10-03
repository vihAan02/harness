// The sandbox around repo-controlled setup commands (D-52, D-69), checked against real srt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createWorktree, gitCommonDir } from '../src/git.ts';
import { runSetup, type SetupRun } from '../src/setup.ts';
import { makeRepo, tempDir, tempHome, TOKEN } from './fixtures.ts';

let t: ReturnType<typeof tempDir>;
let run: (command: string, extra?: Partial<SetupRun>) => Promise<{ exitCode: number; out: string }>;
let wt: string;
let sibling: string;
let repo: string;

before(async () => {
  t = tempDir('setup');
  const home = tempHome(t.dir);
  const made = makeRepo(t.dir, { 'package.json': '{}\n' });
  repo = made.repo;
  wt = path.join(home.worktrees, 'prj', 'task-a');
  sibling = path.join(home.worktrees, 'prj', 'task-b');
  for (const [w, id] of [[wt, 'task-a'], [sibling, 'task-b']] as const) {
    fs.mkdirSync(path.dirname(w), { recursive: true });
    await createWorktree(repo, w, id, made.sha);
  }
  fs.writeFileSync(path.join(sibling, 'secret-in-sibling.txt'), 'SIBLING-SECRET');
  const common = await gitCommonDir(repo);
  let n = 0;
  run = async (command, extra = {}) => {
    const logFile = path.join(home.logs, `setup-${++n}.log`);
    const r: SetupRun = { home, worktree: wt, gitCommonDir: common, scratch: path.join(home.scratch, 'prj', 'task-a'), command, allowedDomains: [], timeoutMs: 30_000, logFile, ...extra };
    const { exitCode } = await runSetup(r);
    return { exitCode, out: fs.readFileSync(logFile, 'utf8') };
  };
});
after(() => t?.cleanup());

test('writes inside the worktree work, and the command runs in it', async () => {
  const r = await run('echo built > built.txt && pwd');
  assert.equal(r.exitCode, 0, r.out);
  assert.equal(fs.readFileSync(path.join(wt, 'built.txt'), 'utf8'), 'built\n');
});

test('package-manager style caches land in the task scratch HOME, not the real one', async () => {
  const r = await run('mkdir -p "$HOME/.cache" "$TMPDIR" && echo c > "$HOME/.cache/x" && echo c > "$TMPDIR/y" && echo "$HOME $TMPDIR"');
  assert.equal(r.exitCode, 0, r.out);
  assert.match(r.out, /scratch\/prj\/task-a\/home .*scratch\/prj\/task-a\/tmp/);
});

test('writes outside the worktree fail: the main checkout, the shared .git, the real home', async () => {
  for (const target of [path.join(repo, 'escape.txt'), path.join(repo, '.git', 'refs', 'heads', 'evil'), path.join(t.dir, 'escape.txt')]) {
    const r = await run(`echo STARTED && echo x > '${target}'`);
    assert.match(r.out, /STARTED/, `the sandbox never ran the command: ${r.out}`);
    assert.notEqual(r.exitCode, 0, `wrote ${target}`);
    assert.equal(fs.existsSync(target), false, `${target} exists`);
  }
});

test('reads of harnessd state fail: the local token and a sibling worktree', async () => {
  const token = await run(`echo STARTED && cat '${path.join(path.dirname(path.dirname(path.dirname(wt))), 'token')}'`);
  assert.match(token.out, /STARTED/, `the sandbox never ran the command: ${token.out}`);
  assert.notEqual(token.exitCode, 0);
  assert.ok(!token.out.includes(TOKEN), 'the token leaked');
  const sib = await run(`echo STARTED && cat '${path.join(sibling, 'secret-in-sibling.txt')}'`);
  assert.match(sib.out, /STARTED/, `the sandbox never ran the command: ${sib.out}`);
  assert.notEqual(sib.exitCode, 0);
  assert.ok(!sib.out.includes('SIBLING-SECRET'), 'the sibling worktree leaked');
});

test('reads inside its own worktree still work, though the worktree sits under the denied harness dir', async () => {
  const r = await run('cat package.json');
  assert.equal(r.exitCode, 0, r.out);
  assert.match(r.out, /\{\}/);
});

test('the environment carries no secrets or harness credentials', async () => {
  process.env.HARNESS_LOCAL_TOKEN_PROBE = 'should-not-pass';
  const r = await run('env');
  delete process.env.HARNESS_LOCAL_TOKEN_PROBE;
  assert.equal(r.exitCode, 0, r.out);
  assert.ok(!/HARNESS_LOCAL_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|should-not-pass/.test(r.out), r.out);
});

test('network is closed unless the local allowlist names the domain', async () => {
  const r = await run('echo STARTED && curl -s -m 5 -o /dev/null -w "%{http_code}" https://example.com/');
  assert.match(r.out, /STARTED/, `the sandbox never ran the command: ${r.out}`);
  assert.notEqual(r.exitCode, 0, r.out);
});

test('the shared .git stays readable, so read-only git works', async () => {
  const r = await run('git status --porcelain && git log --oneline -1');
  assert.equal(r.exitCode, 0, r.out);
  assert.match(r.out, /base/);
});

/** Exit code of a command run outside any sandbox. */
const runPlain = (cmd: string) => spawnSync('sh', ['-c', cmd], { stdio: 'ignore', timeout: 10_000 }).status;

test('a land\'s test command may serve and reach 127.0.0.1 with allowLocalBinding, and only then (D-83)', async () => {
  // A server on loopback and a request to it: what Shelf's tests do.
  const script = "const s=require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',()=>fetch('http://127.0.0.1:'+s.address().port).then(r=>r.text()).then(t=>{console.log('LOOPBACK', t);process.exit(0)},e=>{console.log('FAILED', e.cause?.code ?? e.message);process.exit(3)}));setTimeout(()=>{console.log('TIMEOUT');process.exit(4)},8000)";
  fs.writeFileSync(path.join(wt, 'loop.cjs'), script);
  const on = await run('echo STARTED && node loop.cjs', { allowLocalBinding: true });
  assert.equal(on.exitCode, 0, on.out);
  assert.match(on.out, /LOOPBACK ok/);
  // Negative control: without it, the sandbox refuses (the D-83 finding), so the setting is what makes it work.
  const off = await run('echo STARTED && node loop.cjs');
  assert.match(off.out, /STARTED/, 'the command ran');
  assert.notEqual(off.exitCode, 0, off.out);
  // Still no network beyond loopback: through srt's proxy (an empty domain allowlist) ...
  const net = await run('echo STARTED && curl -s -m 5 -o /dev/null https://example.com/', { allowLocalBinding: true });
  assert.match(net.out, /STARTED/, net.out);
  assert.notEqual(net.exitCode, 0, net.out);
  // ... and directly, bypassing the proxy: the sandbox rule allowLocalBinding changes (F-58). Checked only when
  // this machine can reach the address outside the sandbox, so the test can't pass just by being offline.
  const direct = "--noproxy '*' -s -m 5 -o /dev/null http://1.1.1.1/";
  const online = runPlain(`curl ${direct}`) === 0;
  const raw = await run(`echo STARTED && curl ${direct}`, { allowLocalBinding: true });
  assert.match(raw.out, /STARTED/, raw.out);
  if (online) assert.notEqual(raw.exitCode, 0, `reached 1.1.1.1 from inside the sandbox: ${raw.out}`);
});
