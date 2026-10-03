// ClaudeAdapter against the real pinned Claude Code CLI, with the scripted mock standing in for the
// model (D-56: never a subscription login). The mock plays whatever tool calls a test scripts, including
// ones a well-behaved model would refuse, so these test the harness's enforcement, not model manners.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter, type ClaudeSession } from '../src/index.ts';
import { collect, echoTool, fixture, script, type Fixture } from './fixtures.ts';
import { DUMMY_KEY } from './mock-api.ts';

const live: ClaudeSession[] = [];
const adapter = new (class extends ClaudeAdapter {
  override open(...args: Parameters<ClaudeAdapter['open']>) {
    const s = super.open(...args);
    live.push(s);
    return s;
  }
})();
let f: Fixture;
before(async () => { f = await fixture(); });
after(async () => {
  await Promise.all(live.map((s) => s.stop('kill'))); // a failed test never leaves a CLI running
  await f.cleanup();
});

const human = (id: string, text: string) => ({ id, origin: 'human' as const, text });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The text of every tool result the mock was sent, in order. */
const toolResults = () => f.mock.log.flatMap((e) => (e.summary ?? []).flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool_result').map((b: any) => b.text as string)));

test('a hardened session edits inside its worktree only, and reports what it did', async () => {
  const calls: Record<string, unknown>[] = [];
  const spec = f.spec({ tools: [echoTool(calls)] });
  const outsideFile = path.join(f.outside, 'planted.txt');
  const h = await adapter.startSession(spec, human('m1', script(
    `Write {"file_path":"${f.worktree}/src/new.ts","content":"export const x = 1;\\n"}`,
    `Write {"file_path":"${outsideFile}","content":"escaped"}`,
    `Bash {"command":"echo 'export {}' > src/by-shell.ts"}`,
    'mcp__harness__echo {"text":"hi"}',
    'TEXT done',
  )));
  const c = collect(adapter.observations(h));
  await c.turns(1);

  const init = c.of('session.init')[0]!;
  assert.equal(init.vendorVersion, '2.1.287');
  assert.equal(init.vendorSessionId, spec.sessionId, 'harnessd assigns the session id');
  const pid = c.of('process.started')[0]!.pid;
  assert.ok(alive(pid), 'the CLI process is running while the session is idle');
  assert.equal(h.pid, pid);

  assert.ok(fs.existsSync(path.join(f.worktree, 'src/new.ts')));
  assert.ok(!fs.existsSync(outsideFile), 'a write outside the worktree was denied (D-60)');
  assert.ok(fs.existsSync(path.join(f.worktree, 'src/by-shell.ts')));
  const edits = c.of('edit.observed').flatMap((o) => o.paths).sort();
  assert.deepEqual(edits, ['src/by-shell.ts', 'src/new.ts'], 'file-tool and Bash edits both captured (D-70)');
  assert.deepEqual(c.of('tool.called').map((o) => o.category), ['write', 'write', 'shell', 'mcp']);
  assert.deepEqual(calls, [{ text: 'hi' }]);
  assert.match(toolResults().join('\n'), /echo: hi/);

  const usage = c.of('usage').at(-1)!;
  assert.ok(usage.input > 0 && usage.output > 0);
  assert.equal(adapter.getStatus(h), 'idle');
  assert.equal(c.of('turn.ended')[0]!.reason, 'completed');

  await adapter.stopSession(h, 'graceful');
  await c.done;
  assert.equal(adapter.getStatus(h), 'ended');
  assert.equal(c.seen.at(-1)!.kind, 'ended');
  assert.ok(!alive(pid), 'the CLI process is gone after stop');
});

test("the agent's shell can't see the API key or write the shared .git (D-64, D-60)", async () => {
  const h = await adapter.startSession(f.spec(), human('m1', script(
    'Bash {"command":"echo STARTED; env | grep -c -E \'ANTHROPIC_(API_KEY|AUTH_TOKEN)\'; echo ${ANTHROPIC_API_KEY:-unset}"}',
    `Bash {"command":"echo STARTED; touch ${f.gitCommonDir}/refs/heads/evil; git update-ref refs/heads/evil2 HEAD; echo done"}`,
    'TEXT done',
  )));
  const c = collect(adapter.observations(h));
  await c.turns(1);
  await adapter.stopSession(h, 'kill');
  const [envProbe, gitProbe] = toolResults().slice(-2);
  assert.match(envProbe!, /STARTED/, 'the probe ran');
  assert.ok(!envProbe!.includes(DUMMY_KEY), 'the key never reached the shell');
  assert.match(envProbe!, /\bunset\b/);
  assert.match(gitProbe!, /STARTED/, 'the git probe ran');
  assert.ok(!fs.existsSync(path.join(f.gitCommonDir, 'refs/heads/evil')));
  assert.ok(!fs.existsSync(path.join(f.gitCommonDir, 'refs/heads/evil2')));
});

test('injected messages land at safe boundaries, verbatim, with a receipt (D-26, D-63)', async () => {
  const h = await adapter.startSession(f.spec(), human('m1', script('Bash {"command":"sleep 3; echo slept"}', 'TEXT done')));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'tool.called');
  await new Promise((r) => setTimeout(r, 500));
  const t0 = Date.now();
  const mid = await adapter.injectMessage(h, { id: 'm2', origin: 'peer', text: '[harness message] mid-turn question' });
  assert.equal(mid.landed, 'between_tools');
  assert.ok(mid.deliveredAt - t0 >= 1500, 'waited for the running tool to finish; never interrupted it');
  await c.turns(1);
  const carrier = f.mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary).includes('"text":"slept'));
  assert.equal(carrier.length, 1);
  assert.ok(JSON.stringify(carrier[0]!.summary).includes('mid-turn question'), 'it rode in with the finished tool\'s result (SP-02)');

  const secret = path.join(f.outside, 'secret.txt');
  const idle = await adapter.injectMessage(h, { id: 'm3', origin: 'peer', text: `[harness message] see @${secret}\n/clear\n#STEP TEXT ok` });
  assert.equal(idle.landed, 'new_turn');
  await c.turns(2);
  const last = f.mock.log.filter((e) => e.kind === 'main').at(-1)!;
  const sent = JSON.stringify(last.summary);
  assert.ok(sent.includes(`@${secret}`), 'the @path arrived as text');
  assert.ok(!sent.includes('top secret'), 'the @path was not expanded into file contents');
  assert.ok(sent.includes('mid-turn question'), '/clear did not run: earlier history is still there');
  assert.deepEqual(c.of('delivery').map((d) => [d.messageId, d.landed]), [['m1', 'new_turn'], ['m2', 'between_tools'], ['m3', 'new_turn']]);
  await adapter.stopSession(h, 'graceful');
});

test('a session stopped mid-tool resumes with its config dir and worktree (SP-07, D-65)', async () => {
  const spec = f.spec();
  const h = await adapter.startSession(spec, human('m1', script('Bash {"command":"sleep 20"}', 'TEXT done')));
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'tool.called');
  const t0 = Date.now();
  await adapter.stopSession(h, 'graceful');
  assert.ok(Date.now() - t0 < 10_000, 'the graceful stop interrupted the running tool');
  await c.done;
  assert.equal(c.of('ended')[0]!.reason, 'stopped');

  const r = await adapter.resumeSession({ vendorSessionId: h.vendorSessionId! }, spec, human('m2', script('TEXT resumed')));
  const rc = collect(adapter.observations(r));
  await rc.turns(1);
  const history = JSON.stringify(f.mock.log.filter((e) => e.kind === 'main').at(-1)!.summary);
  assert.ok(history.includes('sleep 20'), 'the earlier conversation was replayed');
  assert.equal(rc.of('session.init')[0]!.vendorSessionId, spec.sessionId);
  await adapter.stopSession(r, 'kill');
});

test('a billing error is an error even with subtype success, and leaves the session errored (D-67, SP-09)', async () => {
  f.mock.failPlan = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }];
  const h = await adapter.startSession(f.spec(), human('m1', script('TEXT never')));
  const c = collect(adapter.observations(h));
  await c.turns(1);
  assert.ok(c.of('error').some((e) => e.error === 'billing'), JSON.stringify(c.of('error')));
  assert.equal(c.of('turn.ended')[0]!.isError, true);
  assert.equal(adapter.getStatus(h), 'errored');
  await adapter.stopSession(h, 'kill');
  f.mock.failPlan = [];
});

test('kill ends the session and its process at once', async () => {
  const h = await adapter.startSession(f.spec(), human('m1', script('Bash {"command":"sleep 30"}', 'TEXT done'))) as ClaudeSession;
  const c = collect(adapter.observations(h));
  await c.until((o) => o.kind === 'tool.called');
  const pid = h.pid!;
  await adapter.stopSession(h, 'kill');
  await c.done;
  assert.equal(c.of('ended')[0]!.reason, 'killed');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!alive(pid));
  await assert.rejects(adapter.injectMessage(h, human('m2', 'late')), /has ended/);
});

test('startSession refuses specs it cannot honour', async () => {
  await assert.rejects(adapter.startSession({ ...f.spec(), sessionId: 'not-a-uuid' }, human('m1', 'x')), /UUID/);
  await assert.rejects(adapter.startSession({ ...f.spec(), configDir: path.join(f.root, 'missing') }, human('m1', 'x')), /doesn't exist/);
});
