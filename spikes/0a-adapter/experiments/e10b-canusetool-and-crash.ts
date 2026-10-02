// Q10 follow-up: canUseTool failure modes on a non-sandboxed tool (Write), and
// what happens to a running agent when its supervisor (harnessd) is SIGKILLed.
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep } from '../lib/session.ts';

const f = makeFixture('e10b');
const out: any[] = [];
for (const kind of ['deny', 'throw', 'hang']) {
  const mock = await startMock();
  const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-${kind}` });
  fs.mkdirSync(o.env.CLAUDE_CONFIG_DIR, { recursive: true });
  o.allowedTools = ['Read'];
  o.permissionMode = 'default';
  o.canUseTool = async () => {
    if (kind === 'deny') return { behavior: 'deny', message: 'no' };
    if (kind === 'throw') throw new Error('canUseTool exploded');
    await sleep(120000); return { behavior: 'allow', updatedInput: {} };
  };
  const target = `${f.wtA}/cut-${kind}.txt`;
  const t0 = Date.now();
  const { run, done } = startRun(`cut\n#STEP Write ${JSON.stringify({ file_path: target, content: 'x' })}`, o);
  const finished = await Promise.race([done.then(() => true), sleep(40000).then(() => false)]);
  if (!finished) { run.q?.close(); await sleep(500); }
  await mock.close();
  const tr = run.messages.filter((m: any) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result').map((m: any) => String(m.message.content[0].content).slice(0, 160));
  out.push({ case: `canUseTool-${kind}`, wrote: fs.existsSync(target), finished, ms: Date.now() - t0, toolResults: tr, error: run.error });
}

// Supervisor crash: a child "harnessd" runs a session whose Bash appends a heartbeat every 0.5 s for 12 s.
const mock = await startMock();
const hb = `${f.wtA}/heartbeat.txt`;
fs.writeFileSync(`${f.root}/runner.ts`, `
import { hardenedOptions, startRun } from '${import.meta.dirname}/../lib/session.ts';
const mock = { url: '${mock.url}' } as any;
const o = hardenedOptions({ cwd: '${f.wtA}', mock, configDir: '${f.configB}' });
const { done } = startRun('hb\\n#STEP Bash ${JSON.stringify({ command: `for i in $(seq 1 24); do echo $i >> heartbeat.txt; sleep 0.5; done` }).replace(/"/g, '\\"')}', o);
await done;
`);
const child = spawn(process.execPath, [`${f.root}/runner.ts`], { stdio: ['ignore', 'pipe', 'pipe'] });
let childErr = ''; child.stderr.on('data', (d) => (childErr += d));
await sleep(4000);
const linesBefore = fs.existsSync(hb) ? fs.readFileSync(hb, 'utf8').trim().split('\n').length : 0;
const claudeChildren = () => execSync(`ps -axo pid,ppid,command | grep 'claude-agent-sdk-darwin-arm64/claude' | grep -v grep || true`).toString().trim();
const psBefore = claudeChildren();
process.kill(child.pid!, 'SIGKILL');
await sleep(500);
const psJustAfter = claudeChildren();
await sleep(6000);
const linesAfter = fs.existsSync(hb) ? fs.readFileSync(hb, 'utf8').trim().split('\n').length : 0;
const psLater = claudeChildren();
await sleep(8000);
const linesFinal = fs.existsSync(hb) ? fs.readFileSync(hb, 'utf8').trim().split('\n').length : 0;
await mock.close();
out.push({ case: 'supervisor-sigkill', childPid: child.pid, linesBeforeKill: linesBefore, linesAfter6s: linesAfter, linesAfter14s: linesFinal, psBefore, psJustAfter, psLater, childErr: childErr.slice(-300) });

fs.writeFileSync(`${f.root}/result.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
