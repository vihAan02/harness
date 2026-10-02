// D-52: run repo-controlled setup/test commands sandboxed OUTSIDE a Claude session,
// using Anthropic's sandbox-runtime CLI (srt).
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeFixture } from '../lib/fixture.ts';

const f = makeFixture('e12');
const settings = `${f.root}/srt-settings.json`;
fs.writeFileSync(settings, JSON.stringify({
  filesystem: { allowWrite: [f.wtA], denyWrite: [`${f.gitCommonDir}`], denyRead: [f.outside, '~/.ssh', '~/.aws'], allowRead: [] },
  network: { allowedDomains: ['registry.npmjs.org'], deniedDomains: [] },
}, null, 2));
const srt = `${import.meta.dirname}/../node_modules/.bin/srt`;
const cases: [string, string][] = [
  ['write in worktree', `echo ok > '${f.wtA}/setup-out.txt' && echo WROTE`],
  ['write outside worktree', `echo x > '${f.outside}/setup-escape.txt' && echo WROTE`],
  ['write $HOME', `echo x >> ~/.harness-srt-escape-test && echo WROTE`],
  ['write shared .git refs', `echo x > '${f.gitCommonDir}/refs/heads/evil' && echo WROTE`],
  ['read denied secret', `cat '${f.secretFile}'`],
  ['read ~/.ssh listing', `ls ~/.ssh 2>&1 | head -2`],
  ['network allowlisted (npm registry)', `curl -s -m 8 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/ ; echo " rc=$?"`],
  ['network not allowlisted', `curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com/ ; echo " rc=$?"`],
  ['env passthrough', `echo "HARNESS_TEST_SECRET=\${HARNESS_TEST_SECRET:-absent}"`],
];
const rows = cases.map(([name, cmd]) => {
  let outp = '';
  try { outp = execFileSync(srt, ['-s', settings, '-c', cmd], { cwd: f.wtA, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH!, HOME: os.homedir(), HARNESS_TEST_SECRET: 'passed-by-harnessd' }, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e: any) { outp = `EXIT ${e.status}: ${(e.stdout ?? '') + (e.stderr ?? '')}`; }
  return { name, out: outp.replace(/\n/g, ' | ').slice(0, 200) };
});
fs.rmSync(`${os.homedir()}/.harness-srt-escape-test`, { force: true });
for (const r of rows) console.log(`${r.name.padEnd(36)} -> ${r.out}`);
console.log('files:', { inWorktree: fs.existsSync(`${f.wtA}/setup-out.txt`), outside: fs.existsSync(`${f.outside}/setup-escape.txt`), gitRef: fs.existsSync(`${f.gitCommonDir}/refs/heads/evil`) });
// Invalid configs must make srt refuse to run (fail closed).
for (const [label, content] of [['missing required key', JSON.stringify({ filesystem: { allowWrite: [f.wtA], denyWrite: [], denyRead: [] }, network: { allowedDomains: [] } })], ['not JSON', '{oops']] as [string, string][]) {
  const bad = `${f.root}/srt-bad.json`; fs.writeFileSync(bad, content);
  let r = '';
  try { r = 'RAN: ' + execFileSync(srt, ['-s', bad, '-c', `echo ran > '${f.wtA}/should-not-exist.txt'`], { cwd: f.wtA, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e: any) { r = `EXIT ${e.status}: ${String(e.stderr ?? '').split('\n')[0].slice(0, 120)}`; }
  console.log(`invalid config (${label})`.padEnd(36), '->', r, '| command ran:', fs.existsSync(`${f.wtA}/should-not-exist.txt`));
}
console.log('srt version:', execFileSync(srt, ['--version'], { encoding: 'utf8' }).trim());
