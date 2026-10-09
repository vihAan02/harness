// T-1 for harnessd's UI socket (D-117, F-119): the socket hands out snapshots, approvals and commands to whoever holds
// its token, so no sandboxed process may even connect to it. An agent's shell and a setup command each try, at a socket
// path no read rule covers (/tmp); both are refused, while this OS user's own process connects. In production the
// socket and its token are also under ~/.harness, which agents can't read (D-98).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { gitCommonDir } from '../../packages/daemon/src/git.ts';
import { runSetup } from '../../packages/daemon/src/setup.ts';
import { startStack, steps, type Stack } from '../support.ts';

const short = fs.mkdtempSync('/tmp/hui-'); // macOS caps socket paths at 104 bytes
const socket = path.join(fs.realpathSync(short), 'run', 'harnessd.sock');
const j = (o: unknown) => JSON.stringify(o);
const probe = (lang: 'node' | 'python') => (lang === 'node'
  ? `node -e "require('net').connect('${socket}').on('connect',()=>{console.log('UIRPC-CONNECTED');process.exit(0)}).on('error',e=>{console.log('UIRPC-REFUSED '+e.code);process.exit(3)})"`
  : `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('${socket}'); print('UIRPC-CONNECTED')" 2>&1 | tail -1`);

let s: Stack;
before(async () => {
  s = await startStack({ portRange: [32300, 32399], files: { 'src/app.ts': 'export const app = 1;\n' }, daemonOptions: { uiSocket: socket } });
});
after(async () => {
  await s?.stop();
  fs.rmSync(short, { recursive: true, force: true });
});

test('this OS user\'s own process reaches the socket (the control)', async () => {
  const c = net.connect(socket);
  await new Promise<void>((resolve, reject) => { c.once('connect', () => resolve()); c.once('error', reject); });
  c.end();
});

test('an agent\'s shell can\'t connect to harnessd\'s UI socket, by Node or by Python', async () => {
  const agent = (await s.command('agent.create', { name: 'agent/prober', vendor: 'claude' })).agent_id!;
  const t = await s.assignTask(agent, 'Probe', ['src/'], steps(
    `Bash ${j({ command: 'echo AGENT-SHELL-OK' })}`,
    `Bash ${j({ command: probe('node') })}`,
    `Bash ${j({ command: probe('python') })}`,
    'TEXT probed',
  ));
  await s.turnEnds(t, 1, 90_000);
  const results = s.toolResults('probed');
  assert.equal(results.length, 3, results.join('\n---\n'));
  assert.match(results[0]!, /AGENT-SHELL-OK/, 'the shell runs');
  for (const r of results.slice(1)) {
    assert.ok(!r.includes('UIRPC-CONNECTED'), `connected: ${r}`);
  }
  assert.match(results[1]!, /UIRPC-REFUSED E(PERM|ACCES)/, results[1]);
});

test('a setup command (srt, with local binding allowed as for a land\'s tests) can\'t connect either', async () => {
  const scratch = path.join(s.home.scratch, 'probe');
  const logFile = path.join(s.home.logs, 'probe.log');
  const r = await runSetup({
    home: s.home, worktree: s.repo, gitCommonDir: await gitCommonDir(s.repo), scratch, command: probe('node'),
    allowedDomains: [], timeoutMs: 30_000, logFile, allowLocalBinding: true,
  });
  const out = fs.readFileSync(logFile, 'utf8');
  assert.notEqual(r.exitCode, 0, out);
  assert.ok(!out.includes('UIRPC-CONNECTED'), out);
  assert.match(out, /UIRPC-REFUSED E(PERM|ACCES)/, out);
});
