// Follow-ups from the fact-check of spike-0a.md:
// (a) idle shouldQuery:false really waits for the next querying message;
// (b) bashEditDiff with vs without bashEditDiffEnabled;
// (c) sandboxed Bash vs EVERY /tmp/cc-socks socket, including a live target session's.
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, recordingHooks, sleep, Inbox, type HookRecord } from '../lib/session.ts';
const f = makeFixture('e16');
// (a)
{
  const mock = await startMock();
  const inbox = new Inbox();
  inbox.push('t1\n#STEP TEXT one', { origin: { kind: 'human' } } as any);
  let n = 0; let tNoQuery = 0, tHuman = 0;
  const { run, done } = startRun(inbox, hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-a` }), (m: any) => {
    if (m.type === 'result' && ++n === 1) {
      tNoQuery = Date.now(); inbox.push('SILENT-CONTEXT-NOQUERY', { origin: { kind: 'coordinator' }, shouldQuery: false, client_composed: true } as any);
      setTimeout(() => { tHuman = Date.now(); inbox.push('t2\n#STEP TEXT two', { origin: { kind: 'human' }, client_composed: true } as any); }, 4000);
    }
    // The no-query message itself yields a zero-turn result, so the human turn's result is the third.
    if (m.type === 'result' && n === 3) inbox.close();
  });
  await Promise.race([done, sleep(20000)]); await mock.close();
  const mains = mock.log.filter((e) => e.kind === 'main');
  const first = mains.find((e) => JSON.stringify(e.summary).includes('SILENT-CONTEXT-NOQUERY'));
  console.log('(a) idle shouldQuery:false', JSON.stringify({ requestsInFirst4s: mains.filter((e) => e.t > tNoQuery && e.t < tHuman).length, firstSeenMsAfterNoQueryPush: first ? first.t - tNoQuery : null, firstSeenMsAfterHumanPush: first ? first.t - tHuman : null, resultNumTurns: run.results.map((r: any) => r.num_turns) }));
}
// (b)
for (const flag of [true, false]) {
  const mock = await startMock();
  const hooks: HookRecord[] = [];
  const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-b-${flag}`, hooks: recordingHooks(hooks) });
  fs.mkdirSync(o.env.CLAUDE_CONFIG_DIR, { recursive: true });
  if (!flag) delete o.settings.bashEditDiffEnabled;
  const { done } = startRun(`b\n#STEP Bash ${JSON.stringify({ command: `echo x > flag-${flag}.txt` })}\n#STEP TEXT x`, o);
  await done; await mock.close();
  const post = hooks.find((h) => h.event === 'PostToolUse' && h.tool === 'Bash');
  console.log('(b) bashEditDiffEnabled', flag, '-> bashEditDiff present:', !!post?.response?.bashEditDiff, 'files:', JSON.stringify(post?.response?.bashEditDiff?.changedFiles?.map((p: string) => p.split('/').pop()) ?? null));
}
// (c)
{
  const mockT = await startMock();
  const inT = new Inbox();
  inT.push('target\n#STEP Bash {"command":"sleep 30"}', { origin: { kind: 'human' } } as any);
  const T = startRun(inT, hardenedOptions({ cwd: f.wtB, mock: mockT, configDir: f.configB }));
  await sleep(3000);
  const tPid = execSync(`ps -axo pid,ppid,command | grep 'claude-agent-sdk-darwin-arm64/claude' | grep -v grep | awk '$2==${process.pid}{print $1}'`).toString().trim().split('\n')[0];
  const socks = fs.readdirSync('/tmp/cc-socks').filter((s) => { try { return fs.statSync(`/tmp/cc-socks/${s}`).isSocket(); } catch { return false; } });
  const script = `import socket,os\nok=[];bad=[]\nfor s in ${JSON.stringify(socks)}:\n  p='/tmp/cc-socks/'+s\n  c=socket.socket(socket.AF_UNIX);c.settimeout(2)\n  try:\n    c.connect(p);ok.append(s)\n  except Exception as e:\n    bad.append(s+':'+type(e).__name__)\nprint('CONNECTED',ok);print('FAILED',len(bad),sorted(set(b.split(':')[1] for b in bad)))`;
  fs.writeFileSync(`${f.wtA}/probe.py`, script);
  const mock = await startMock();
  const { run, done } = startRun('c\n#STEP Bash {"command":"python3 probe.py"}\n#STEP TEXT x', hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-c` }));
  await done; await mock.close();
  const out = run.messages.filter((m: any) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result').map((m: any) => String(m.message.content[0].content))[0];
  console.log('(c) sockets tried:', socks.length, 'live target socket included:', socks.includes(`${tPid}.sock`), '->', out?.replace(/\n/g, ' | '));
  inT.close(); T.q.close(); await Promise.race([T.done, sleep(3000)]); await mockT.close();
}
