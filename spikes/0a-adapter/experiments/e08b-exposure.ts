// Q8 follow-up: credential exposure to the agent's shell and mitigations; whether a
// sandboxed shell can reach a sibling session's messaging socket; network defaults.
import fs from 'node:fs';
import { startMock, DUMMY_KEY } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep, Inbox } from '../lib/session.ts';

const f = makeFixture('e08b');
const probeKey = `#STEP Bash ${JSON.stringify({ command: 'if [ -n "$ANTHROPIC_API_KEY" ]; then echo "KEY-VISIBLE len=${#ANTHROPIC_API_KEY} prefix=${ANTHROPIC_API_KEY:0:7}"; else echo KEY-ABSENT; fi; env | grep -c ANTHROPIC_API_KEY' })}`;
const out: any[] = [];
async function one(name: string, tweak: (o: any) => void, steps: string[]) {
  const mock = await startMock();
  const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-${name}` });
  fs.mkdirSync(o.env.CLAUDE_CONFIG_DIR, { recursive: true });
  tweak(o);
  const { run, done } = startRun([name, ...steps].join('\n'), o);
  await Promise.race([done, sleep(45000)]);
  await mock.close();
  const tr = run.messages.filter((m: any) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result').map((m: any) => String(m.message.content[0].content).replace(/\n/g, ' | ').slice(0, 260));
  const authOk = mock.log.filter((e) => e.kind === 'main').every((e) => e.authOk);
  out.push({ case: name, apiKeySource: run.init?.apiKeySource, modelCallsAuthOk: authOk, error: run.error, toolResults: tr });
}

await one('key-in-env (baseline)', () => {}, [probeKey]);
await one('sandbox-credentials-deny', (o) => { o.sandbox.credentials = { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }] }; }, [probeKey]);
await one('sandbox-credentials-mask', (o) => { o.sandbox.credentials = { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'mask' }] }; }, [probeKey]);
await one('apiKeyHelper-in-flag-settings', (o) => { delete o.env.ANTHROPIC_API_KEY; o.settings.apiKeyHelper = `echo ${DUMMY_KEY}`; }, [probeKey]);

// Sibling socket + network, using a second live session as the target.
{
  const mockT = await startMock();
  const inbox = new Inbox();
  inbox.push('target\n#STEP Bash {"command":"sleep 25"}', { origin: { kind: 'human' } } as any);
  const oT: any = hardenedOptions({ cwd: f.wtB, mock: mockT, configDir: f.configB });
  const T = startRun(inbox, oT);
  await sleep(3000);
  const sock = fs.readdirSync('/tmp/cc-socks').map((s) => `/tmp/cc-socks/${s}`).filter((p) => { try { return fs.statSync(p).isSocket(); } catch { return false; } });
  const tryConnect = (p: string) => `python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.settimeout(2);s.connect('${p}');print('CONNECTED ${p.split('/').pop()}')" 2>&1 | tail -1`;
  const steps = [
    `#STEP Bash ${JSON.stringify({ command: 'ls -la /tmp/cc-socks | head -8' })}`,
    ...sock.slice(0, 3).map((p) => `#STEP Bash ${JSON.stringify({ command: tryConnect(p) })}`),
    `#STEP Bash ${JSON.stringify({ command: 'curl -s -m 5 -o /dev/null -w "%{http_code}" https://example.com; echo " rc=$?"' })}`,
    `#STEP Bash ${JSON.stringify({ command: '(python3 -m http.server 41999 --bind 127.0.0.1 >/dev/null 2>&1 &); sleep 1.2; curl -s -m 2 -o /dev/null -w "%{http_code}" http://127.0.0.1:41999/; echo " rc=$?"' })}`,
  ];
  await one('sibling-socket+network (defaults)', () => {}, steps);
  inbox.close(); T.q.close(); await Promise.race([T.done, sleep(3000)]); await mockT.close();
}
fs.writeFileSync(`${f.root}/result.json`, JSON.stringify(out, null, 2));
for (const r of out) console.log(`\n=== ${r.case}: apiKeySource=${r.apiKeySource} authOk=${r.modelCallsAuthOk} error=${r.error ?? '-'}\n  ${r.toolResults.join('\n  ')}`);
