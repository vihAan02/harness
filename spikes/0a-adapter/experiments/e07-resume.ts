// Q7: can we resume a session after stopping the process?
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMock, summarize } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, recordingHooks, sleep, Inbox, type HookRecord } from '../lib/session.ts';

const f = makeFixture('e07');
const out: any = {};
const firstRequestOf = (mock: any) => mock.log.find((e: any) => e.kind === 'main');

// (a) graceful stop, resume in-process with a harness-chosen session id.
{
  const id = randomUUID();
  const mock = await startMock();
  const r1 = startRun('turn one: remember SECRET-WORD-17\n#STEP TEXT noted SECRET-WORD-17', hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA, overrides: { sessionId: id } }));
  await r1.done;
  const transcriptDir = path.join(f.configA, 'projects');
  const files = fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir, { recursive: true }).map(String).filter((x) => x.endsWith('.jsonl')) : [];
  const hooks: HookRecord[] = [];
  const r2 = startRun('turn two after resume\n#STEP TEXT resumed', hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA, hooks: recordingHooks(hooks), overrides: { resume: id } }));
  await r2.done;
  const mains = mock.log.filter((e) => e.kind === 'main');
  const resumedReq = mains.at(-1)!;
  out.graceful = {
    chosenId: id, initIdRun1: r1.run.init?.session_id, initIdRun2: r2.run.init?.session_id,
    transcriptFiles: files,
    resumedRequestHasTurnOne: JSON.stringify(resumedReq.summary).includes('SECRET-WORD-17'),
    resumedRequestMessages: resumedReq.summary?.map((m: any) => `${m.role}:${m.blocks.map((b: any) => b.type).join('+')}`),
    hooksFiredAfterResume: [...new Set(hooks.map((h) => h.event))],
    errors: [r1.run.error, r2.run.error],
    costRun2: (r2.run.results.at(-1) as any)?.total_cost_usd,
  };
  await mock.close();
}

// (b) hard kill mid-tool (q.close() kills the subprocess), then resume from a DIFFERENT process.
{
  const id = randomUUID();
  const mock = await startMock({ rawDir: `${f.root}/raw-b` });
  const r1 = startRun(`killed turn\n#STEP Bash ${JSON.stringify({ command: 'sleep 6; echo finished-sleep > killed.txt' })}\n#STEP TEXT never`, hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA, overrides: { sessionId: id } }));
  await sleep(2500);
  r1.q.close();
  await Promise.race([r1.done, sleep(3000)]);
  await sleep(5000);
  const killedFileWritten = fs.existsSync(`${f.wtA}/killed.txt`);
  // Resume from a separate node process.
  const runner = `${f.root}/resume-runner.ts`;
  fs.writeFileSync(runner, `
import { hardenedOptions, startRun } from '${import.meta.dirname}/../lib/session.ts';
const o = hardenedOptions({ cwd: '${f.wtA}', mock: { url: '${mock.url}' } as any, configDir: '${f.configA}', overrides: { resume: '${id}' } });
const { run, done } = startRun('after crash\\n#STEP TEXT back', o);
await done;
console.log(JSON.stringify({ error: run.error, initId: run.init?.session_id, result: run.results.at(-1)?.subtype }));
`);
  // Async: the mock lives in this process and must keep serving while the child runs.
  const res = await promisify(execFile)(process.execPath, [runner], { timeout: 60000 }).catch((e: any) => ({ stdout: e.stdout ?? '', stderr: String(e.stderr ?? e) }));
  const resumedReq = mock.log.filter((e) => e.kind === 'main').at(-1)!;
  const raw = fs.readFileSync(`${f.root}/raw-b/${String(resumedReq.i).padStart(4, '0')}-main.json`, 'utf8');
  const msgs = JSON.parse(raw).messages;
  out.hardKill = {
    killedToolCompletedAnyway: killedFileWritten,
    childStdout: res.stdout.trim(), childStderrTail: res.stderr.slice(-300),
    resumedRequest: summarize(msgs).map((m: any) => ({ role: m.role, blocks: m.blocks.map((b: any) => ({ type: b.type, text: (b.text ?? '').slice(0, 160) })) })),
  };
  await mock.close();
}

// (c) resume with a different cwd (the other worktree).
{
  const id = randomUUID();
  const mock = await startMock();
  const r1 = startRun('cwd test\n#STEP TEXT x', hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA, overrides: { sessionId: id } }));
  await r1.done;
  const r2 = startRun('resume elsewhere\n#STEP TEXT y', hardenedOptions({ cwd: f.wtB, mock, configDir: f.configA, overrides: { resume: id } }));
  await Promise.race([r2.done, sleep(30000)]);
  const last = mock.log.filter((e) => e.kind === 'main').at(-1)!;
  out.differentCwd = { error: r2.run.error, result: (r2.run.results.at(-1) as any)?.subtype, resultErrors: (r2.run.results.at(-1) as any)?.errors, sawHistory: JSON.stringify(last.summary).includes('cwd test'), stderr: r2.run.stderr.join('').slice(-300) };
  await mock.close();
}

// (d) resume with a different CLAUDE_CONFIG_DIR (what if harnessd lost its per-agent config dir?).
{
  const id = randomUUID();
  const mock = await startMock();
  const r1 = startRun('cfg test\n#STEP TEXT x', hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA, overrides: { sessionId: id } }));
  await r1.done;
  const r2 = startRun('resume other cfg\n#STEP TEXT y', hardenedOptions({ cwd: f.wtA, mock, configDir: f.configB, overrides: { resume: id } }));
  await Promise.race([r2.done, sleep(30000)]);
  out.differentConfigDir = { error: r2.run.error, result: (r2.run.results.at(-1) as any)?.subtype, resultErrors: (r2.run.results.at(-1) as any)?.errors };
  await mock.close();
}
fs.writeFileSync(`${f.root}/result.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
