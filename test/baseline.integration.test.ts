// The A/B baseline arm's launch (validation.md §3; A7, D-102): an interactive Claude Code with the harness
// arm's policy and none of the treatment. The first test compares the launch with what an SDK session gets;
// the second runs the pinned CLI in a pseudo-terminal against the scripted mock.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_TOOLS, ClaudeAdapter, sessionEnv, type SessionSpec } from '../packages/adapters/src/index.ts';
import { DUMMY_KEY, startMock } from '../packages/adapters/test/mock-api.ts';
import { STANDING_INSTRUCTION } from '../packages/daemon/src/instructions.ts';
import { gitIn, makeRepo, tempDir, tempHome } from '../packages/daemon/test/fixtures.ts';
import { baselineSpec } from '../scripts/ab/baseline-launch.ts';

const t = tempDir('baseline');
after(() => t.cleanup());
const home = tempHome(t.dir);
const { repo } = makeRepo(t.dir, { 'AGENTS.md': 'REPO-RULE: keep functions small.\n', 'src/a.ts': 'export {}\n' });
fs.writeFileSync(home.config, ['device_id = "dev_test"', 'principal = "human_test"', 'server_url = "wss://example.invalid"', '[[projects]]', 'id = "prj_x"', `repo = "${repo}"`, ''].join('\n'));
const wt = path.join(t.dir, 'wt-front');
gitIn(repo, 'worktree', 'add', '-q', '-b', 'front', wt);
const env = { ...process.env, ANTHROPIC_API_KEY: DUMMY_KEY };
const spec = () => baselineSpec({ worktree: wt, repo, agent: 'front', ports: { base: 31900, count: 10 }, home, env });
/** The value after a flag, in either form the SDK writes. */
const flagOf = (args: string[], name: string) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};

test('the baseline launch gives Claude Code the harness arm\'s policy, and none of the treatment', async () => {
  const s = await spec();
  const adapter = new ClaudeAdapter();
  const launch = adapter.interactiveLaunch(s);
  const real = adapter.prepare(s);
  const policy = adapter.compilePermissions(real); // what an SDK session with this spec gets
  assert.deepEqual(JSON.parse(flagOf(launch.args, 'settings')!), { ...(policy.settings as object), sandbox: policy.sandbox });
  assert.equal(flagOf(launch.args, 'allowedTools'), policy.allowedTools!.join(','));
  assert.ok(!flagOf(launch.args, 'allowedTools')!.includes('mcp__harness'), 'no harness tools');
  assert.equal(flagOf(launch.args, 'tools'), BASE_TOOLS.join(','));
  assert.equal(flagOf(launch.args, 'disallowedTools'), 'SendMessage,ListAgents', 'the vendor\'s own peer channel stays off (F-17)');
  assert.equal(flagOf(launch.args, 'setting-sources'), '');
  assert.equal(flagOf(launch.args, 'permission-mode'), 'dontAsk');
  assert.ok(launch.args.includes('--strict-mcp-config'));
  assert.ok(real.readPolicy && JSON.parse(flagOf(launch.args, 'settings')!).sandbox.filesystem.denyRead.length > 0, 'read confinement, as harnessd computes it');
  const prompt = flagOf(launch.args, 'append-system-prompt')!;
  assert.match(prompt, /REPO-RULE: keep functions small\./);
  assert.match(prompt, /Your ports are 31900–31909/);
  for (const treatment of ['coordination harness', STANDING_INSTRUCTION, 'wait_for', '[harness']) assert.ok(!prompt.includes(treatment), treatment);
  assert.deepEqual(launch.env, sessionEnv(real));
  assert.equal(launch.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(launch.env.PORT, '31900');
  assert.ok(!launch.args.join(' ').includes(DUMMY_KEY), 'the key travels in the environment only (D-64)');
  assert.equal(launch.cwd, fs.realpathSync(wt));
  const seeded = JSON.parse(fs.readFileSync(path.join(s.configDir, '.claude.json'), 'utf8'));
  assert.deepEqual(seeded.customApiKeyResponses.approved, [DUMMY_KEY.slice(-20)]);
});

/** Runs a command in a pseudo-terminal for `secs` seconds and returns what it printed. */
const PTY = `
import os, pty, sys, time, select, signal
secs = float(sys.argv[1]); pid, fd = pty.fork()
if pid == 0: os.execvp(sys.argv[2], sys.argv[2:])
out = b''; start = time.time()
while time.time() - start < secs:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: out += os.read(fd, 65536)
        except OSError: break
os.kill(pid, signal.SIGKILL); sys.stdout.buffer.write(out)
`;

test('in a terminal, the interactive CLI starts at once on the API key and sends the model what the launch says (F-109)', async () => {
  const mock = await startMock();
  const seen: { body?: { model?: string; system?: { text: string }[]; tools?: { name: string }[] } } = {};
  mock.onMain = (b) => { seen.body ??= b; };
  try {
    const s: SessionSpec = { ...await spec(), auth: { mode: 'api-key', apiKey: DUMMY_KEY, baseUrl: mock.url }, model: { id: 'claude-haiku-4-5' } };
    const launch = new ClaudeAdapter().interactiveLaunch(s);
    const child = spawn('python3', ['-c', PTY, '10', launch.command, ...launch.args, '#STEP TEXT hello from the baseline'], { cwd: launch.cwd, env: { ...launch.env, BROWSER: '/usr/bin/true' } });
    let screen = '';
    child.stdout.on('data', (d: Buffer) => { screen += d.toString(); });
    await new Promise((r) => child.on('exit', r));
    const text = screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[78=>]/g, '').replace(/\s+/g, '');
    const body = seen.body;
    assert.ok(body, `the session reached the model; screen: ${text.slice(-600)}`);
    const main = mock.log.find((e) => e.kind === 'main')!;
    assert.ok(main.authOk, 'with the API key, never a subscription login (D-56)');
    assert.equal(body.model, 'claude-haiku-4-5');
    assert.deepEqual(body.tools!.map((x) => x.name).sort(), [...BASE_TOOLS].sort());
    const system = body.system!.map((x) => x.text).join('\n');
    assert.match(system, /REPO-RULE: keep functions small\./);
    assert.ok(!system.includes('coordination harness'), 'no harness text');
    assert.match(text, /hellofromthebaseline/, 'it ran the turn');
    assert.match(text, /APIUsageBilling/, 'billed to the API key');
    assert.match(text, /don'taskon/, 'in the dontAsk permission mode');
  } finally {
    await mock.close();
  }
});
