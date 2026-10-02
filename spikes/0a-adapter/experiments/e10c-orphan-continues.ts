// Q10: after harnessd is SIGKILLed mid-tool, does the orphaned claude keep calling
// the model and running further tools? (with and without an in-process PreToolUse hook)
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { sleep } from '../lib/session.ts';

const f = makeFixture('e10c');
const out: any[] = [];
for (const withHook of [false, true]) {
  const tag = withHook ? 'hook' : 'nohook';
  const mock = await startMock();
  const steps = [
    `#STEP Bash ${JSON.stringify({ command: `sleep 3; echo s1 > o-${tag}-1` })}`,
    `#STEP Bash ${JSON.stringify({ command: `echo s2 > o-${tag}-2` })}`,
    `#STEP Write ${JSON.stringify({ file_path: `${f.wtA}/o-${tag}-3`, content: 's3' })}`,
    '#STEP TEXT end',
  ].join('\\n');
  fs.writeFileSync(`${f.root}/runner-${tag}.ts`, `
import { hardenedOptions, startRun } from '${import.meta.dirname}/../lib/session.ts';
const o: any = hardenedOptions({ cwd: '${f.wtA}', mock: { url: '${mock.url}' } as any, configDir: '${f.root}/cfg-${tag}' });
${withHook ? "o.hooks = { PreToolUse: [{ timeout: 5, hooks: [async () => ({})] }] };" : ''}
const { done } = startRun('orphan test\\n${steps.replace(/'/g, "\\'")}', o);
await done;
`);
  fs.mkdirSync(`${f.root}/cfg-${tag}`, { recursive: true });
  const child = spawn(process.execPath, [`${f.root}/runner-${tag}.ts`], { stdio: 'ignore' });
  await sleep(2500); // inside step 1's sleep 3
  const reqsAtKill = mock.log.filter((e) => e.kind === 'main').length;
  const { execSync } = await import('node:child_process');
  const claudePid = execSync(`ps -axo pid,ppid,command | grep 'claude-agent-sdk-darwin-arm64/claude' | grep -v grep | awk '$2==${child.pid}{print $1}'`).toString().trim();
  process.kill(child.pid!, 'SIGKILL');
  await sleep(20000);
  const mains = mock.log.filter((e) => e.kind === 'main');
  const orphanAlive = claudePid ? execSync(`ps -p ${claudePid} -o pid= || true`).toString().trim() !== '' : null;
  out.push({ withInProcessPreToolUseHook: withHook, reqsAtKill, reqsTotal: mains.length, claudePid, orphanStillRunning20sAfterKill: orphanAlive,
    markers: [1, 2, 3].map((i) => `${i}:${fs.existsSync(`${f.wtA}/o-${tag}-${i}`)}`),
    lastToolResult: (() => { const last = mains.at(-1); return last?.summary ? JSON.stringify(last.summary.at(-1)).slice(0, 300) : null; })() });
  await mock.close();
}
console.log(JSON.stringify(out, null, 2));
