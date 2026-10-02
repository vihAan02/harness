// Dump command_lifecycle frames for one mid-turn injection.
import fs from 'node:fs';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, Inbox, sleep } from '../lib/session.ts';
const f = makeFixture('peek');
const mock = await startMock();
const inbox = new Inbox();
const first = inbox.push('t\n#STEP Bash {"command":"sleep 2; echo a"}\n#STEP Bash {"command":"sleep 1; echo b"}\n#STEP TEXT end', { origin: { kind: 'human' } } as any);
let pushed = false; let injected = '';
const { run, done } = startRun(inbox, hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA }), (m: any) => {
  if (!pushed && m.type === 'assistant') { pushed = true; setTimeout(() => { injected = inbox.push('INJECTED', { origin: { kind: 'peer', from: 'b' }, client_composed: true } as any); }, 300); }
});
await sleep(6000); inbox.close(); await Promise.race([done, sleep(5000)]); await mock.close();
console.log('first uuid', first, 'injected uuid', injected);
for (const m of run.messages as any[]) if (m.type === 'command_lifecycle' || (m.type === 'user' && !m.message?.content?.[0]?.tool_use_id) || m.type === 'result') console.log(JSON.stringify({ ...m, _t: undefined, message: m.message ? '[..]' : undefined, usage: undefined, modelUsage: undefined }).slice(0, 400));
