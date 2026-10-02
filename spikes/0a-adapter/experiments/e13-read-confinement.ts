// F-12 / 0B read confinement: which channel actually blocks reads of a secret
// outside the worktree, for file tools, shell reads and @-mentions?
import fs from 'node:fs';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep, Inbox } from '../lib/session.ts';

const f = makeFixture('e13');
const S = (tool: string, input: any) => `#STEP ${tool} ${JSON.stringify(input)}`;
const attempts = [
  ['Read tool', S('Read', { file_path: f.secretFile })],
  ['Grep tool', S('Grep', { pattern: 'SECRET', path: f.outside, output_mode: 'content' })],
  ['Glob tool', S('Glob', { pattern: '*', path: f.outside })],
  ['Bash cat', S('Bash', { command: `cat '${f.secretFile}'` })],
  ['Bash python', S('Bash', { command: `python3 -c "print(open('${f.secretFile}').read())"` })],
  ['Bash grep -r', S('Bash', { command: `grep -r SECRET '${f.outside}'` })],
];
const variants: [string, (o: any) => void][] = [
  ['none', () => {}],
  ['flag-settings Read deny', (o) => { o.settings.permissions.deny = [`Read(/${f.outside}/**)`]; }],
  ['sdk sandbox.filesystem.denyRead', (o) => { o.sandbox.filesystem = { denyRead: [f.outside] }; }],
  ['both', (o) => { o.settings.permissions.deny = [`Read(/${f.outside}/**)`]; o.sandbox.filesystem = { denyRead: [f.outside] }; }],
  ['managedSettings Read deny', (o) => { o.managedSettings = { permissions: { deny: [`Read(/${f.outside}/**)`] } }; }],
];
for (const [name, tweak] of variants) {
  const mock = await startMock({ rawDir: `${f.root}/raw-${name.replace(/\W+/g, '-')}` });
  const inbox = new Inbox();
  inbox.push(['read test', ...attempts.map((a) => a[1]), '#STEP TEXT t1'].join('\n'), { origin: { kind: 'human' } } as any);
  const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-${name.replace(/\W+/g, '-')}` });
  fs.mkdirSync(o.env.CLAUDE_CONFIG_DIR, { recursive: true });
  tweak(o);
  let n = 0;
  const { run, done } = startRun(inbox, o, (m: any) => {
    if (m.type === 'result' && ++n === 1) inbox.push(`mention @${f.secretFile}\n#STEP TEXT t2`, { origin: { kind: 'human' } } as any);
    if (m.type === 'result' && n === 2) inbox.close();
  });
  await Promise.race([done, sleep(60000)]);
  await mock.close();
  const tr = run.messages.filter((m: any) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result').map((m: any) => (typeof m.message.content[0].content === 'string' ? m.message.content[0].content : JSON.stringify(m.message.content[0].content)));
  const allBodies = fs.readdirSync(`${f.root}/raw-${name.replace(/\W+/g, '-')}`).map((x) => fs.readFileSync(`${f.root}/raw-${name.replace(/\W+/g, '-')}/${x}`, 'utf8'));
  const lastBody = allBodies.at(-1) ?? '';
  console.log(`\n===== ${name} (error=${run.error ?? '-'})`);
  attempts.forEach(([label], i) => { const t = tr[i] ?? ''; console.log(`${t.includes('SECRET-OUTSIDE') ? 'LEAKED ' : 'blocked'} ${label.padEnd(12)} ${t.replace(/\n/g, ' ').slice(0, 140)}`); });
  console.log(`${lastBody.includes('SECRET-OUTSIDE-WORKTREE-42') ? 'LEAKED ' : 'blocked'} @-mention`);
}
