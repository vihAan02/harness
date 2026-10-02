// Smoke test: does the real Claude Code binary run against the mock, hardened?
import fs from 'node:fs';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture, markersPresent } from '../lib/fixture.ts';
import { hardenedOptions, recordingHooks, startRun, compact, type HookRecord } from '../lib/session.ts';

const f = makeFixture('e00');
const mock = await startMock({ rawDir: `${f.root}/raw` });
const hooks: HookRecord[] = [];
const prompt = [
  'Spike smoke test.',
  '#STEP Bash {"command":"echo hello-from-bash && pwd"}',
  `#STEP Write {"file_path":"${f.wtA}/hello.txt","content":"hi\\n"}`,
  '#STEP TEXT all done',
].join('\n');
const { run, done } = startRun(prompt, hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA, hooks: recordingHooks(hooks) }));
await done;
await mock.close();

const out = {
  error: run.error,
  init: run.init && { apiKeySource: run.init.apiKeySource, claude_code_version: run.init.claude_code_version, cwd: run.init.cwd, tools: run.init.tools, mcp_servers: run.init.mcp_servers, slash_commands: run.init.slash_commands, skills: run.init.skills, plugins: run.init.plugins, permissionMode: run.init.permissionMode, model: run.init.model, capabilities: run.init.capabilities, agents: run.init.agents },
  messages: compact(run),
  hookEvents: hooks.map((h) => `${h.event}:${h.tool ?? ''}`),
  markers: markersPresent(f),
  helloExists: fs.existsSync(`${f.wtA}/hello.txt`),
  mockLog: mock.log.map((e) => ({ i: e.i, path: e.path, kind: e.kind, authOk: e.authOk, bearer: e.bearerPresent, model: e.model, step: e.stepIndex, emitted: e.emitted })),
  stderrTail: run.stderr.join('').slice(-2000),
};
fs.writeFileSync(`${f.root}/result.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
