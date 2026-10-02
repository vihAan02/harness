// Q1 + Q8: launch and supervise two sessions at once; check isolation of config,
// ports, Git state and credentials; check what the agent's shell can see.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture, gitStatus } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep, Inbox } from '../lib/session.ts';

const f = makeFixture('e08');
const realProjects = path.join(os.homedir(), '.claude', 'projects');
const realBefore = fs.existsSync(realProjects) ? fs.readdirSync(realProjects).filter((d) => d.includes('runs-e08')) : [];

const envProbe = `env | grep -E '^(CLAUDE|ANTHROPIC|HARNESS|PORT|HOME|USER_SETTINGS|REPO_SETTINGS)' | sed -E 's/^([A-Z_]*(KEY|TOKEN)[A-Z_]*)=(.*)$/\\1=<present,redacted>/' | cut -c1-140 | sort`;
function script(tag: string) {
  return [
    `session ${tag}`,
    `#STEP Bash ${JSON.stringify({ command: envProbe })}`,
    `#STEP Bash ${JSON.stringify({ command: '(python3 -m http.server $HARNESS_PORT --bind 127.0.0.1 >/dev/null 2>&1 &) ; sleep 1.5; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$HARNESS_PORT/ ; echo " port=$HARNESS_PORT"; pkill -f "http.server $HARNESS_PORT" || true' })}`,
    `#STEP Bash ${JSON.stringify({ command: `for i in 1 2 3 4; do echo ${tag}-$i >> progress-${tag}.txt; sleep 0.5; done; git status --porcelain | head -5` })}`,
    `#STEP Bash ${JSON.stringify({ command: 'sleep 4; echo slow-step-done' })}`,
    '#STEP TEXT finished',
  ].join('\n');
}

const mockA = await startMock(); const mockB = await startMock();
const inA = new Inbox(); const inB = new Inbox();
inA.push(script('A'), { origin: { kind: 'human' } } as any);
inB.push(script('B'), { origin: { kind: 'human' } } as any);
const oA = hardenedOptions({ cwd: f.wtA, mock: mockA, configDir: f.configA, env: { HARNESS_PORT: '41011', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } });
const oB = hardenedOptions({ cwd: f.wtB, mock: mockB, configDir: f.configB, env: { HARNESS_PORT: '41111', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } });
(oA.sandbox as any).network = { allowLocalBinding: true };
(oB.sandbox as any).network = { allowLocalBinding: true };
const t0 = Date.now();
const A = startRun(inA, oA); const B = startRun(inB, oB);

// Supervision: find both claude PIDs; interrupt A during its slow step; B must keep going.
const pids = () => execSync(`ps -axo pid,ppid,command | grep 'claude-agent-sdk-darwin-arm64/claude' | grep -v grep || true`).toString().trim().split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/).slice(0, 2).map(Number)).filter(([, pp]) => pp === process.pid).map(([p]) => p);
await sleep(2500);
const pidsRunning = pids();
const listening = pidsRunning.map((p) => execSync(`lsof -nP -a -p ${p} -iTCP -sTCP:LISTEN 2>/dev/null || true`).toString().trim());
const unixSockets = pidsRunning.map((p) => execSync(`lsof -nP -a -p ${p} -U 2>/dev/null | awk '{print $NF}' | sort -u | head -20 || true`).toString().trim());
let interruptReceipt: any = null;
const waitFor = async (cond: () => boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end && !cond()) await sleep(100); };
await waitFor(() => A.run.messages.some((m: any) => m.type === 'assistant' && JSON.stringify(m.message.content).includes('slow-step-done')), 20000);
await sleep(1000);
const tInterrupt = Date.now();
interruptReceipt = await A.q.interrupt().catch((e: any) => String(e));
await waitFor(() => A.run.results.length > 0, 10000);
const aResultAfterInterrupt: any = A.run.results.at(-1);
inA.close(); A.q.close();
await Promise.race([A.done, sleep(5000)]);
const pidsAfterACloses = pids();
await waitFor(() => B.run.results.length > 0, 20000);
inB.close();
await Promise.race([B.done, sleep(5000)]);

const toolOut = (run: any) => run.messages.filter((m: any) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result').map((m: any) => String(m.message.content[0].content).slice(0, 700));
const states = (run: any) => run.messages.filter((m: any) => m.type === 'system' && m.subtype === 'session_state_changed').map((m: any) => `${m.state}@${m._t - t0}`);
const listDir = (d: string) => fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String).filter((x) => !x.includes('/')).sort() : [];
const realAfter = fs.existsSync(realProjects) ? fs.readdirSync(realProjects).filter((d) => d.includes('runs-e08')) : [];
const out = {
  pidsRunning, listening, unixSockets,
  A: { sessionId: A.run.init?.session_id, apiKeySource: A.run.init?.apiKeySource, toolOut: toolOut(A.run), states: states(A.run), interruptReceipt, resultAfterInterrupt: aResultAfterInterrupt && { subtype: aResultAfterInterrupt.subtype, terminal_reason: aResultAfterInterrupt.terminal_reason, is_error: aResultAfterInterrupt.is_error, ms: aResultAfterInterrupt._t - tInterrupt } },
  B: { sessionId: B.run.init?.session_id, apiKeySource: B.run.init?.apiKeySource, toolOut: toolOut(B.run), states: states(B.run), result: (B.run.results.at(-1) as any)?.subtype, finishedAfterAInterrupted: ((B.run.results.at(-1) as any)?._t ?? 0) > tInterrupt },
  pidsAfterACloses,
  progressInterleaving: { A: fs.readFileSync(`${f.wtA}/progress-A.txt`, 'utf8').trim().split('\n').length, B: fs.readFileSync(`${f.wtB}/progress-B.txt`, 'utf8').trim().split('\n').length },
  gitStatusA: gitStatus(f.wtA), gitStatusB: gitStatus(f.wtB),
  configA: listDir(f.configA), configB: listDir(f.configB),
  realClaudeProjectsTouched: realAfter.filter((d) => !realBefore.includes(d)),
};
await mockA.close(); await mockB.close();
fs.writeFileSync(`${f.root}/result.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
