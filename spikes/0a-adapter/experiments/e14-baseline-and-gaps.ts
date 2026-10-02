// (1) A/B baseline arm: the plain CLI with no setting sources + appended repo instructions.
// (2) Edit-capture gap: writes made by a background process after the command returns.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startMock, DUMMY_KEY } from '../lib/mock-api.ts';
import { makeFixture, markersPresent } from '../lib/fixture.ts';
import { hardenedOptions, startRun, recordingHooks, sleep, type HookRecord } from '../lib/session.ts';

const f = makeFixture('e14');
const bin = `${import.meta.dirname}/../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
// (1)
{
  const mock = await startMock({ rawDir: `${f.root}/raw-baseline` });
  fs.writeFileSync(`${f.root}/repo-instructions.md`, fs.readFileSync(`${f.repo}/CLAUDE.md`, 'utf8') + '\nBASELINE-APPEND-MARKER\n');
  const args = ['-p', 'baseline run\n#STEP Bash {"command":"echo hi"}\n#STEP TEXT done', '--setting-sources', '', '--append-system-prompt-file', `${f.root}/repo-instructions.md`,
    '--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,Edit,Write,Bash', '--disallowedTools', 'SendMessage,ListAgents',
    '--settings', JSON.stringify({ sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true }, crossSessionInbound: 'refuse' }),
    '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json'];
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, ANTHROPIC_API_KEY: DUMMY_KEY, ANTHROPIC_BASE_URL: mock.url, CLAUDE_CONFIG_DIR: f.configA, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  const r = await promisify(execFile)(bin, args, { cwd: f.wtA, env, timeout: 60000 }).catch((e: any) => ({ stdout: e.stdout, stderr: e.stderr }));
  await mock.close();
  const bodies = fs.readdirSync(`${f.root}/raw-baseline`).map((x) => fs.readFileSync(`${f.root}/raw-baseline/${x}`, 'utf8')).join('\n');
  let parsed: any = {}; try { parsed = JSON.parse(r.stdout); } catch {}
  console.log('BASELINE:', JSON.stringify({ result: parsed.result, is_error: parsed.is_error, markersFired: markersPresent(f), appendedInPrompt: bodies.includes('BASELINE-APPEND-MARKER'), repoClaudeMdViaAppend: bodies.includes('REPO-CLAUDE-MD-MARKER'), stderr: String(r.stderr ?? '').slice(-200) }));
}
// (2)
{
  const mock = await startMock();
  const hooks: HookRecord[] = [];
  const o: any = hardenedOptions({ cwd: f.wtB, mock, configDir: f.configB, hooks: recordingHooks(hooks) });
  const { run, done } = startRun(['gap', `#STEP Bash ${JSON.stringify({ command: '(sleep 2; echo late > late-bg.txt) > /dev/null 2>&1 &' })}`,
    `#STEP Bash ${JSON.stringify({ command: 'sleep 1; echo writes-later > later-tool.txt; echo started', run_in_background: true })}`, '#STEP Bash {"command":"sleep 4; echo waited"}', '#STEP TEXT x'].join('\n'), o);
  await Promise.race([done, sleep(30000)]); await sleep(1000); await mock.close();
  const diffs = hooks.filter((h) => h.event === 'PostToolUse' && h.tool === 'Bash').map((h) => (h.response?.bashEditDiff?.changedFiles ?? []).map((p: string) => p.split('/').pop()));
  console.log('BACKGROUND WRITES:', JSON.stringify({ lateBgExists: fs.existsSync(`${f.wtB}/late-bg.txt`), laterToolExists: fs.existsSync(`${f.wtB}/later-tool.txt`), bashEditDiffPerCall: diffs, fileChangedHooks: hooks.filter((h) => h.event === 'FileChanged').length }));
}
