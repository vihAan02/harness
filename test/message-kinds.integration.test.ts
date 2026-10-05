// The 0B message kinds (0B item 6; D-105), end to end with the real CLI: an agent asks another to define a
// contract and gets the answer between its tool calls; then it reports its task blocked, and the report
// reaches the task's owner in `harness status`, never as a delivery to an agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, steps, type Stack } from './support.ts';

let s: Stack;
before(async () => { s = await startStack({ portRange: [31500, 31599], files: { 'src/api/login.ts': 'export {}\n', 'src/web/Login.tsx': 'export {}\n' } }); });
after(async () => { await s?.stop(); });

test('the 0B kinds end to end: a contract request is answered; a blocked report reaches the owner in `harness status` (D-105)', async () => {
  const owner = (await s.command('agent.create', { name: 'agent/types', vendor: 'claude' })).agent_id!;
  const user = (await s.command('agent.create', { name: 'agent/client', vendor: 'claude' })).agent_id!;
  const tOwner = await s.assignTask(owner, 'Shared types', ['src/api/'], steps(
    'TEXT ready',
    'mcp__harness__answer {"question_id":"{{find:KIND: contract_request   ID: (msg_[0-9a-f]+)}}","text":"LoginResponse is { token: string; expiresAt: string }."}',
    'TEXT answered',
  ));
  await s.turnEnds(tOwner);
  const tUser = await s.assignTask(user, 'Client', ['src/web/'], steps(
    'mcp__harness__request_contract {"to":"agent/types","contract":"Define the response type of POST /login.","about_paths":["src/api/login.ts"]}',
    'Bash {"command":"sleep 6; echo built"}',
    'mcp__harness__report_blocked {"reason":"The staging API key is missing; only a person can issue one.","on":"agent/types"}',
    'TEXT done',
  ));
  const delivered = async (kind: string) => (await s.nextEvent((e) => e.kind === 'message.delivered' && (e.data as { kind: string }).kind === kind && (e.data as { to: string }).to !== undefined)).data as Record<string, any>;
  const req = await delivered('contract_request');
  assert.deepEqual([req.to, req.delivery], [owner, 'new_turn']);
  const ans = await delivered('answer');
  assert.equal(ans.to, user);
  const blocked = (await s.nextEvent((e) => e.kind === 'message.sent' && (e.data as { kind: string }).kind === 'task_blocked')).data as Record<string, any>;
  assert.deepEqual([blocked.from, blocked.to, blocked.to_task_id, blocked.blocked_on, blocked.priority], [user, 'human_test', tUser, { kind: 'agent', id: owner }, 'normal']);
  await s.turnEnds(tUser);

  // What the owner read: the request in its envelope, quoted, with the hint to answer it.
  const atOwner = JSON.stringify(s.mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary).includes('KIND: contract_request')).at(-1)!.summary);
  assert.match(atOwner, /SOURCE: peer-agent agent\/client[^"]*KIND: contract_request/);
  assert.match(atOwner, /> Define the response type of POST \/login\./);
  assert.match(atOwner, /define or confirm it with the `answer` tool/);
  // The client's tools told it what happened.
  const results = s.toolResults('KIND: answer');
  assert.match(results[0]!, /^Sent\. request_id: msg_[0-9a-f]+\./);
  const all = JSON.stringify(s.mock.log.filter((e) => e.kind === 'main').at(-1)!.summary);
  assert.match(all, new RegExp(`Reported to human/human_test: ${tUser} is blocked\\. It stays in progress\\.`));
  // The human sees it in `harness status`, through the real CLI; the report is never "waiting for delivery".
  const status = await s.cli('status');
  assert.match(status, new RegExp(`Blocked \\(task_blocked reports for open tasks\\):\\n  ${tUser} agent/client, blocked on agent/types, [^:]+: "The staging API key is missing; only a person can issue one\\."`));
  assert.equal(s.daemon.view(s.project).tasks.get(tUser)!.status, 'in_progress', 'a report doesn\'t pause the task');
  await Promise.all([s.daemon.stopAgent(tOwner), s.daemon.stopAgent(tUser)]);
});
