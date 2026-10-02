// Can injected (peer) text dispatch a built-in slash command such as /clear?
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep, Inbox } from '../lib/session.ts';
const f = makeFixture('e15');
for (const composed of [false, true]) {
  const mock = await startMock();
  const inbox = new Inbox();
  inbox.push('turn one MEMORY-ANCHOR\n#STEP TEXT one', { origin: { kind: 'human' } } as any);
  let n = 0;
  const { run, done } = startRun(inbox, hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-${composed}` }), (m: any) => {
    if (m.type === 'result') {
      n++;
      if (n === 1) inbox.push('/clear', { origin: { kind: 'peer', from: 'b' }, ...(composed ? { client_composed: true } : {}) } as any);
      if (n === 1) setTimeout(() => inbox.push('turn three\n#STEP TEXT three', { origin: { kind: 'human' } } as any), 1500);
      if (n >= 2) setTimeout(() => inbox.close(), 1500);
    }
  });
  await Promise.race([done, sleep(20000)]);
  await mock.close();
  const last = mock.log.filter((e) => e.kind === 'main').at(-1)!;
  console.log(JSON.stringify({ client_composed: composed, results: n, lastRequestStillHasTurnOne: JSON.stringify(last.summary).includes('MEMORY-ANCHOR'), slashTextSentToModelAsText: mock.log.some((e) => e.kind === 'main' && JSON.stringify(e.summary).includes('"/clear"')), localCommandOutput: run.messages.filter((m: any) => m.type === 'system' && /local_command/.test(m.subtype)).length }));
}
