// The agent-facing tool shim (0A item 6): a real Claude Code session calls harness_status, ask and
// report_done, and each lands on the server as the protocol command it maps to (protocol.md §6).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, steps, type Stack } from './support.ts';

let s: Stack;
before(async () => { s = await startStack({ files: { 'src/api/login.ts': 'export {}\n', 'src/web/Login.tsx': 'export {}\n' } }); });
after(async () => { await s?.stop(); });

test('an agent sees its peers, asks one a question and reports done, through the shim', async () => {
  const backend = (await s.command('agent.create', { name: 'agent/backend', vendor: 'claude' })).agent_id!;
  const frontend = (await s.command('agent.create', { name: 'agent/frontend', vendor: 'claude' })).agent_id!;
  const tWeb = await s.assignTask(frontend, 'Login page', ['src/web/'], 'Build the page');
  await s.turnEnds(tWeb);
  const tApi = await s.assignTask(backend, 'Login API', ['src/api/'], steps(
    'mcp__harness__harness_status {}',
    'mcp__harness__ask {"to":"agent/frontend","text":"Which fields does the login page send?","about_paths":["src/api/login.ts"]}',
    'mcp__harness__answer {"question_id":"msg_nonexistent","text":"x"}',
    'mcp__harness__report_done {"summary":"Built POST /login"}',
    'TEXT done',
  ));
  const sent = await s.nextEvent((e) => e.kind === 'message.sent');
  const completed = await s.nextEvent((e) => e.kind === 'task.completed');
  await s.turnEnds(tApi);

  // Each tool became its protocol command, sent as the agent (D-18).
  assert.deepEqual([sent.actor.principal, sent.actor.on_behalf_of], [backend, 'human_test']);
  const msg = sent.data as Record<string, unknown>;
  assert.deepEqual([msg.kind, msg.from, msg.to, msg.from_task_id, msg.to_task_id, msg.about_paths], ['question', backend, frontend, tApi, tWeb, ['src/api/login.ts']]);
  assert.deepEqual(completed.data, { task_id: tApi, summary: 'Built POST /login', by: backend });

  // And the model got useful results back.
  const [status, asked, badAnswer, done] = s.toolResults(`TASK: ${tApi}`);
  assert.match(status!, new RegExp(`You are agent/backend, working on ${tApi} "Login API"`));
  assert.match(status!, new RegExp(`agent/frontend: working on ${tWeb} "Login page" \\(in_progress\\); session idle`));
  assert.match(status!, /scope: src\/web\//);
  assert.match(asked!, new RegExp(`question_id: ${String(msg.message_id)}`));
  assert.match(badAnswer!, /not_found: no question msg_nonexistent/);
  assert.match(done!, new RegExp(`${tApi} is done`));

  // The model saw exactly the base tools plus the four shim tools, none deferred (F-15, D-66).
  assert.deepEqual(s.requestTools[0], ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write',
    'mcp__harness__answer', 'mcp__harness__ask', 'mcp__harness__harness_status', 'mcp__harness__report_done']);
});
