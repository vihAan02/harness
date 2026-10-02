// F-17 / D-46: does crossSessionInbound:'refuse' stop the vendor's own peer channel?
// Sender S has SendMessage enabled; target T is idle. Only T (by its unique title) is addressed.
import fs from 'node:fs';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep, Inbox } from '../lib/session.ts';

const f = makeFixture('e11');
const out: any[] = [];
for (const [inbound, shared] of [['unset', false], ['unset', true], ['refuse', true]] as [string, boolean][]) {
  const title = `spike-target-${inbound}-${shared ? 'shared' : 'sep'}-${process.pid}`;
  const mockT = await startMock(); const mockS = await startMock();
  const inT = new Inbox();
  inT.push('target idle\n#STEP TEXT waiting', { origin: { kind: 'human' } } as any);
  const oT: any = hardenedOptions({ cwd: f.wtB, mock: mockT, configDir: shared ? `${f.root}/cfg-shared-${inbound}` : `${f.root}/cfgT-${inbound}`, overrides: { title } });
  if (inbound === 'unset') delete oT.settings.crossSessionInbound;
  fs.mkdirSync(oT.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const T = startRun(inT, oT);
  await sleep(3000);
  // Sender: list agents, then message T by title.
  const oS: any = hardenedOptions({ cwd: f.wtA, mock: mockS, configDir: shared ? `${f.root}/cfg-shared-${inbound}` : `${f.root}/cfgS-${inbound}` });
  fs.mkdirSync(oS.env.CLAUDE_CONFIG_DIR, { recursive: true });
  oS.disallowedTools = []; oS.allowedTools = [...oS.allowedTools, 'SendMessage', 'ListAgents'];
  const S = startRun(['sender', '#STEP ListAgents {}', `#STEP SendMessage ${JSON.stringify({ to: title, summary: 'spike', message: `PEER-BYPASS-${inbound}` })}`, '#STEP TEXT sent'].join('\n'), oS);
  await Promise.race([S.done, sleep(30000)]);
  await sleep(6000);
  const delivered = mockT.log.filter((e) => e.kind === 'main').some((e) => JSON.stringify(e.summary).includes(`PEER-BYPASS-${inbound}`));
  const sTool = S.run.messages.filter((m: any) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result').map((m: any) => (typeof m.message.content[0].content === 'string' ? m.message.content[0].content : JSON.stringify(m.message.content[0].content)).replace(/\n/g, ' | ').slice(0, 300));
  const listedTarget = sTool[0]?.includes(title);
  const tFrame = mockT.log.filter((e) => e.kind === 'main').map((e) => JSON.stringify(e.summary)).find((s) => s.includes('PEER-BYPASS'));
  out.push({ targetInbound: inbound, sharedConfigDir: shared, senderSawTargetInListAgents: listedTarget, sendResult: sTool[1], deliveredToTargetModel: delivered, howFramed: tFrame ? tFrame.slice(tFrame.indexOf('PEER-BYPASS') - 300, tFrame.indexOf('PEER-BYPASS') + 60) : null });
  inT.close(); T.q.close(); await Promise.race([T.done, sleep(3000)]);
  await mockT.close(); await mockS.close();
}
console.log(JSON.stringify(out, null, 2));
