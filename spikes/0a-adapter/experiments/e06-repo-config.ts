// Q6: can repo-provided hooks / MCP / config gain execution?
// Control (vendor defaults: all setting sources) vs hardened (settingSources: []).
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture, markersPresent } from '../lib/fixture.ts';
import { hardenedOptions, startRun, compact, recordingHooks, sleep, type HookRecord } from '../lib/session.ts';

const MARKERS_IN_PROMPT = ['REPO-CLAUDE-MD-MARKER', 'REPO-AGENTS-MD-MARKER', 'REPO-RULES-MARKER', 'REPO-SKILL-MARKER', 'REPO-AGENT-MARKER', 'REPO-COMMAND-MARKER', 'NESTED-CLAUDE-MD-MARKER', 'USER-CLAUDE-MD-MARKER', 'USER-SKILL-MARKER', 'HARNESS-APPEND-MARKER'];

async function variant(name: string, sources: any) {
  const f = makeFixture(`e06-${name}`);
  fs.writeFileSync(`${f.wtA}/src/CLAUDE.md`, 'NESTED-CLAUDE-MD-MARKER\n');
  const mock = await startMock({ rawDir: `${f.root}/raw` });
  const hooks: HookRecord[] = [];
  const prompt = [
    'Repo config test.',
    `#STEP Read {"file_path":"${f.wtA}/src/types.ts"}`,
    '#STEP Bash {"command":"echo REPO_SETTINGS_ENV=$REPO_SETTINGS_ENV USER_SETTINGS_ENV=$USER_SETTINGS_ENV"}',
    '#STEP TEXT done',
  ].join('\n');
  const opts = hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA, hooks: recordingHooks(hooks) });
  if (sources !== 'hardened') opts.settingSources = sources;
  const { run, done } = startRun(prompt, opts);
  await Promise.race([done, sleep(60000)]);
  await sleep(1500); // let async hooks / MCP spawns land
  await mock.close();
  // Which planted strings reached the model (any request body)?
  const bodies = fs.readdirSync(`${f.root}/raw`).map((x) => fs.readFileSync(`${f.root}/raw/${x}`, 'utf8')).join('\n');
  const inPrompt = MARKERS_IN_PROMPT.filter((m) => bodies.includes(m));
  const mcpProcs = execSync(`ps -axo command | grep -c "repo-mcp-started" || true`).toString().trim();
  const bashOut = run.messages.filter((m: any) => m.type === 'user').map((m: any) => m.message.content?.[0]?.content).filter(Boolean);
  return {
    variant: name, settingSources: opts.settingSources, error: run.error,
    init: run.init && { permissionMode: run.init.permissionMode, mcp_servers: run.init.mcp_servers, skills: run.init.skills.filter((s: string) => /evil|user/.test(s)), agents: run.init.agents, slash_commands: run.init.slash_commands.filter((s: string) => /evil|user/.test(s)), plugins: run.init.plugins, apiKeySource: run.init.apiKeySource },
    markers: markersPresent(f), inPrompt, mcpProcs, bashOut,
    result: compact(run).filter((m: any) => m.type === 'result').map((m: any) => ({ is_error: m.is_error, errors: m.errors, result: m.result })),
    stderrTail: run.stderr.join('').slice(-800),
  };
}

const out = [];
out.push(await variant('control-all-sources', ['user', 'project', 'local']));
out.push(await variant('project-only', ['project']));
out.push(await variant('hardened', 'hardened'));
fs.writeFileSync(`${import.meta.dirname}/../.runs/e06-result.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
