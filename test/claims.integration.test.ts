// Claims end to end (0A item 7): two live agents on one machine. The harness sees what each is changing,
// from hooks and from worktree diffs, and warns both when one edits the other's territory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, steps, type Stack } from './support.ts';

let s: Stack;
before(async () => {
  s = await startStack({
    files: { 'src/types.ts': 'export type User = { id: string };\n', 'src/api/login.ts': 'export {}\n', 'src/web/Login.tsx': 'export {}\n' },
    daemonOptions: { diffIntervalMs: 300 },
  });
});
after(async () => { await s?.stop(); });

test('observed claims, an overlap warning to both agents, and a background write only the diff catches', async () => {
  const backend = (await s.command('agent.create', { name: 'agent/backend', vendor: 'claude' })).agent_id!;
  const frontend = (await s.command('agent.create', { name: 'agent/frontend', vendor: 'claude' })).agent_id!;
  const apiId = await s.nextTaskId();
  const wtApi = s.worktreeOf(apiId);
  const tApi = await s.assignTask(backend, 'Login API', ['src/api/', 'src/types.ts'], steps(
    `Write {"file_path":"${wtApi}/src/types.ts","content":"export type User = { id: string; token: string };\\n"}`,
    `Edit {"file_path":"${wtApi}/src/api/login.ts","old_string":"export {}","new_string":"export const login = 1;"}`,
    'TEXT done'));
  assert.equal(tApi, apiId);
  await s.turnEnds(tApi);
  const webId = await s.nextTaskId();
  const tWeb = await s.assignTask(frontend, 'Login page', ['src/web/'], steps(
    `Write {"file_path":"${s.worktreeOf(webId)}/src/web/Login.tsx","content":"export const Login = 1;\\n"}`,
    `Bash {"command":"echo '// local tweak' >> src/types.ts"}`,
    'Bash {"command":"(sleep 1; echo generated > src/web/generated.ts) > /dev/null 2>&1 &"}',
    'TEXT done'));
  await s.turnEnds(tWeb);
  const web = s.daemon.running.get(tWeb)!;

  const view = s.daemon.view(s.project);
  await s.until(() => view.claims.get(tWeb)?.observed.has('src/web/generated.ts') === true, 15_000, 'the diff to catch the background write');
  assert.deepEqual([...view.claims.get(tApi)!.observed].sort(), ['src/api/login.ts', 'src/types.ts']);
  assert.deepEqual([...view.claims.get(tWeb)!.observed].sort(), ['src/types.ts', 'src/web/Login.tsx', 'src/web/generated.ts']);

  // The hooks saw both foreground edits, the Bash one through bashEditDiff (F-07). The background write
  // came after its command returned, so no hook ever saw it; only a worktree diff did (SP-03, D-70).
  const hookSaw = s.observed.filter((x) => x.run.sessionId === web.sessionId && x.o.kind === 'edit.observed')
    .flatMap((x) => (x.o as { paths: string[] }).paths).sort();
  assert.deepEqual(hookSaw, ['src/types.ts', 'src/web/Login.tsx']);
  const generatedVia = view.events.filter((e) => e.kind === 'claim.observed' && (e.data as { paths: string[] }).paths.includes('src/web/generated.ts'))
    .map((e) => (e.data as { source: string }).source);
  assert.deepEqual(generatedVia, ['diff']);

  // One overlap, src/types.ts, and a high-priority claim_conflict to each agent.
  const overlap = view.overlaps.filter((o) => o.level === 'observed');
  assert.deepEqual(overlap.map((o) => [o.paths, o.tasks]), [[['src/types.ts'], [tWeb, tApi]]]);
  const conflicts = [...view.messages.values()].filter((m) => m.kind === 'claim_conflict');
  assert.deepEqual(conflicts.map((m) => [view.agentName(m.to), m.priority, m.from]).sort(), [['agent/backend', 'high', 'harness'], ['agent/frontend', 'high', 'harness']]);
  assert.match(conflicts.find((m) => m.to === frontend)!.text, /src\/types\.ts: agent\/backend \(task T-\d+\) is also changing this file\./);

  // Both agents were live, so harnessd delivered each notice and acknowledged it (D-26).
  await s.until(() => conflicts.every((m) => view.messages.get(m.id)?.deliveredAt), 15_000, 'both claim_conflict notices to be delivered');
  assert.ok(conflicts.every((m) => ['between_tools', 'new_turn'].includes(view.messages.get(m.id)!.delivery!)));
  await Promise.all([s.daemon.stopAgent(tApi), s.daemon.stopAgent(tWeb)]);
});
