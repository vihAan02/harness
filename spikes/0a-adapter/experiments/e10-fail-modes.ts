// Q10: what fails open vs fails closed?
// Each case runs a Bash command that leaves a marker file; "ran" = the marker exists.
import fs from 'node:fs';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep } from '../lib/session.ts';

const f = makeFixture('e10');
type Case = { name: string; steps: string[]; opts: (o: any) => void; ran?: () => boolean; extra?: (run: any) => any; maxMs?: number };
const mk = (name: string) => `${f.wtA}/m-${name}`;
const bashMark = (name: string) => `#STEP Bash ${JSON.stringify({ command: `echo ran > m-${name}` })}`;
const throwHook = async () => { throw new Error('hook exploded'); };
const hangHook = async () => { await sleep(60000); return {}; };

const cases: Case[] = [
  { name: 'pre-deny', steps: [bashMark('pre-deny')], opts: (o) => { o.hooks = { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'harness says no' } })] }] }; } },
  { name: 'pre-throw', steps: [bashMark('pre-throw')], opts: (o) => { o.hooks = { PreToolUse: [{ hooks: [throwHook] }] }; } },
  { name: 'pre-timeout', steps: [bashMark('pre-timeout')], opts: (o) => { o.hooks = { PreToolUse: [{ timeout: 2, hooks: [hangHook] }] }; }, maxMs: 30000 },
  { name: 'post-throw', steps: [bashMark('post-throw'), '#STEP Bash {"command":"echo second > m-post-throw-2"}'], opts: (o) => { o.hooks = { PostToolUse: [{ hooks: [throwHook] }] }; }, ran: () => fs.existsSync(mk('post-throw-2')) },
  { name: 'post-timeout', steps: [bashMark('post-timeout'), '#STEP Bash {"command":"echo second > m-post-timeout-2"}'], opts: (o) => { o.hooks = { PostToolUse: [{ timeout: 2, hooks: [hangHook] }] }; }, ran: () => fs.existsSync(mk('post-timeout-2')), maxMs: 30000 },
  { name: 'stop-block', steps: ['#STEP TEXT first-stop'], opts: (o) => { let n = 0; o.hooks = { Stop: [{ hooks: [async () => (++n <= 2 ? { decision: 'block', reason: `keep going ${n}` } : {})] }] }; }, extra: (run) => ({ assistantTexts: run.messages.filter((m: any) => m.type === 'assistant').length }) },
  { name: 'stop-block-forever', steps: ['#STEP TEXT x'], opts: (o) => { o.hooks = { Stop: [{ hooks: [async () => ({ decision: 'block', reason: 'never stop' })] }] }; }, extra: (run) => ({ assistantTexts: run.messages.filter((m: any) => m.type === 'assistant').length, resultSubtype: run.results.at(-1)?.subtype }), maxMs: 60000 },
  { name: 'stop-throw', steps: ['#STEP TEXT x'], opts: (o) => { o.hooks = { Stop: [{ hooks: [throwHook] }] }; }, extra: (run) => ({ results: run.results.length, isError: run.results.at(-1)?.is_error }) },
  { name: 'canusetool-throw', steps: [bashMark('canusetool-throw')], opts: (o) => { o.allowedTools = []; o.permissionMode = 'default'; o.canUseTool = async () => { throw new Error('canUseTool exploded'); }; } },
  { name: 'canusetool-deny', steps: [bashMark('canusetool-deny')], opts: (o) => { o.allowedTools = []; o.permissionMode = 'default'; o.canUseTool = async () => ({ behavior: 'deny', message: 'no' }); } },
  { name: 'canusetool-hang', steps: [bashMark('canusetool-hang')], opts: (o) => { o.allowedTools = []; o.permissionMode = 'default'; o.canUseTool = async () => { await sleep(45000); return { behavior: 'allow', updatedInput: {} }; }; }, maxMs: 25000 },
  { name: 'mcp-tool-throw', steps: ['#STEP mcp__harness__boom {}', bashMark('mcp-tool-throw')], opts: (o) => {
      o.mcpServers = { harness: createSdkMcpServer({ name: 'harness', version: '0.0.1', tools: [tool('boom', 'explodes', {}, async () => { throw new Error('tool exploded'); }, { alwaysLoad: true } as any)] }) };
    }, extra: (run) => ({ toolResults: run.messages.filter((m: any) => m.type === 'user').map((m: any) => JSON.stringify(m.message.content).slice(0, 200)) }) },
  { name: 'sandbox-unsandboxed-allowed', steps: [`#STEP Bash ${JSON.stringify({ command: `echo ran > '${f.outside}/m-unsb'`, dangerouslyDisableSandbox: true })}`], opts: (o) => { o.sandbox = { ...o.sandbox, allowUnsandboxedCommands: true }; }, ran: () => fs.existsSync(`${f.outside}/m-unsb`) },
];

async function runCase(c: Case) {
  const mock = await startMock();
  const o: any = hardenedOptions({ cwd: f.wtA, mock, configDir: `${f.root}/cfg-${c.name}` });
  fs.mkdirSync(o.env.CLAUDE_CONFIG_DIR, { recursive: true });
  c.opts(o);
  const t0 = Date.now();
  const { run, done } = startRun([`fail-mode ${c.name}`, ...c.steps].join('\n'), o);
  const finished = await Promise.race([done.then(() => true), sleep(c.maxMs ?? 40000).then(() => false)]);
  if (!finished) { run.q?.close(); await sleep(500); }
  await mock.close();
  const ran = c.ran ? c.ran() : fs.existsSync(mk(c.name));
  const toolResults = run.messages.filter((m: any) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result').map((m: any) => String(typeof m.message.content[0].content === 'string' ? m.message.content[0].content : JSON.stringify(m.message.content[0].content)).replace(/\n/g, ' ').slice(0, 160));
  return { case: c.name, finished, ms: Date.now() - t0, ran, error: run.error, toolResults, extra: c.extra?.(run), requests: mock.log.filter((e) => e.kind === 'main').length };
}
const out = await Promise.all(cases.map(runCase));
fs.writeFileSync(`${f.root}/result.json`, JSON.stringify(out, null, 2));
for (const r of out) console.log(`\n=== ${r.case}: ran=${r.ran} finished=${r.finished} ms=${r.ms} reqs=${r.requests} error=${r.error ?? '-'}\n  results: ${JSON.stringify(r.toolResults).slice(0, 400)}\n  extra: ${JSON.stringify(r.extra ?? null).slice(0, 400)}`);
