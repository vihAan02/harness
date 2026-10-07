// The A/B runner's baseline arm and what both arms record (B9b; validation.md §4, §9). The first tests are
// pure: the coordinator's console, reading transcripts, and P1's "surfaced". The last two run the baseline
// arm itself, two interactive Claude Code CLIs in pseudo-terminals against the scripted mock, with the
// runner integrating as a coordinator would: once green, once with tests that never pass.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { stringify as toToml } from 'smol-toml';
import type { EventMessage } from '../packages/protocol/src/index.ts';
import { startMock } from '../packages/adapters/test/mock-api.ts';
import { parseConfig, ProjectView } from '../packages/daemon/src/index.ts';
import { gitIn, makeRepo, tempDir, tempHome, TOKEN } from '../packages/daemon/test/fixtures.ts';
import { runBaseline } from '../scripts/ab/baseline-arm.ts';
import { CoordinatorConsole } from '../scripts/ab/console.ts';
import { Recorder } from '../scripts/ab/recorder.ts';
import { checkSummary } from '../scripts/ab/summary.ts';
import { commitsAfterFirst, conflictedTasks, firstAttempt, harnessAttempts, harnessSummary, independentTip, mergeTree, surfaced, untestedRetry, writeDiffs } from '../scripts/ab/summarize.ts';
import { computeMetrics } from '../packages/daemon/src/metrics.ts';
import { readTranscript, transcriptUsage } from '../scripts/ab/transcripts.ts';

const t = tempDir('ab-baseline');
after(() => t.cleanup());
const timeline = (rec: Recorder) => fs.readFileSync(path.join(rec.dir, 'timeline.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { what: string; [k: string]: unknown });

test('the console: Enter toggles the M10 timer, commands run in order, and an interval still open closes at the end', async () => {
  const rec = new Recorder(path.join(t.dir, 'console'));
  const ran: string[] = [];
  const con = new CoordinatorConsole(rec, { merge: { usage: '<agent>', run: async (a) => { ran.push(a); return `merged ${a}`; } } });
  const input = new PassThrough();
  con.start(input);
  input.write('\n');
  await new Promise((r) => setTimeout(r, 120));
  input.write('\nnote relayed the login shape\nmerge backend\nbogus\n\n');
  await new Promise((r) => setTimeout(r, 120));
  input.write('stop\n');
  await new Promise((r) => setTimeout(r, 50));
  await con.close();
  assert.equal(con.stopRequested, true);
  assert.deepEqual(ran, ['backend']);
  const kinds = timeline(rec).map((e) => e.what);
  assert.deepEqual(kinds, ['m10_start', 'm10_stop', 'note', 'command', 'm10_start', 'stop_requested', 'm10_stop']);
  assert.equal(timeline(rec).at(-1)!.at_end, true, 'the open interval closed at the end');
  assert.ok(con.m10Ms() >= 150 && con.m10Ms() < 2000, String(con.m10Ms()));
  assert.match(fs.readFileSync(path.join(rec.dir, 'run.log'), 'utf8'), /unknown command "bogus"/);
});

test('a transcript gives the human\'s messages after the card, interrupts, denied calls and tokens; streamed copies count once', () => {
  const line = (o: unknown) => JSON.stringify(o);
  const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 });
  const lines = [
    line({ type: 'user', message: { role: 'user', content: 'Build the login page (the card).' }, timestamp: '2026-10-05T00:00:00Z' }),
    line({ type: 'assistant', message: { id: 'msg_1', model: 'm-1', content: [{ type: 'text', text: 'Reading.' }], usage: usage(100, 1) } }),
    line({ type: 'assistant', message: { id: 'msg_1', model: 'm-1', content: [{ type: 'tool_use', name: 'Bash' }], usage: usage(100, 20) } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'Permission to use Bash with command curl x has been denied.' }] } }),
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: system text' } }),
    line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'The backend now returns { user, session }.' }] }, timestamp: '2026-10-05T00:01:00Z' }),
    line({ type: 'assistant', isSidechain: true, message: { id: 'msg_s', model: 'm-1', content: [], usage: usage(999, 999) } }),
    line({ type: 'assistant', message: { id: 'msg_2', model: 'm-1', content: [{ type: 'text', text: 'Done.' }], usage: usage(50, 5) } }),
    'not json',
  ];
  const f = readTranscript(lines);
  assert.deepEqual(f.prompts.map((p) => p.at), ['2026-10-05T00:00:00Z', '2026-10-05T00:01:00Z'], 'the card and one message; meta, wrappers and interrupts are not messages');
  assert.equal(f.interrupts, 1);
  assert.equal(f.denied, 1);
  assert.deepEqual(f.byModel['m-1'], { input: 150, output: 25, cacheRead: 20, cacheCreation: 10, vendorCostUsd: 0, vendorBasis: 'unknown' });
  const u = transcriptUsage([f, f], { 'm-1': { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 } });
  assert.deepEqual([u.input, u.output, u.cache_read, u.cache_creation, u.cost_basis], [300, 50, 40, 20, 'config']);
  assert.equal(u.cost_usd, (300 * 1 + 50 * 10 + 40 * 0.1 + 20 * 1) / 1e6, 'priced from the provider table, as the harness arm is');
});

test('P1\'s "surfaced": task 1\'s notice or message naming a planted file, delivered after its first edit there and before the affected task is done', () => {
  let seq = 0;
  const ev = (kind: string, data: Record<string, unknown>, at: number): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'p', seq: ++seq, at: new Date(1_000_000 + at * 1000).toISOString(), actor: { principal: 'x', on_behalf_of: null, device_id: null }, kind, data } as EventMessage);
  const ids = new Map([['T1', 'T-1'], ['T2', 'T-2']]);
  type O = { delivered?: boolean; synced?: boolean; kind?: string; writer?: string; fromTask?: string; editAt?: number; editPath?: string };
  const build = (noticeAt: number, path: string, o: O = {}) => {
    const v = new ProjectView('p');
    for (const id of ['T-1', 'T-2']) v.apply(ev('task.created', { task_id: id, title: id, scope: [], owner_human_id: 'h' }, 0));
    // Task 1's first edit of a planted file opens the window.
    v.apply(ev('claim.observed', { task_id: 'T-1', session_id: 's1', paths: [o.editPath ?? 'src/shared/types.ts'], source: 'hook' }, o.editAt ?? 5));
    if (o.synced) v.apply(ev('worktree.synced', { task_id: 'T-2', old_base_sha: 'a'.repeat(40), new_base_sha: 'b'.repeat(40), changed_paths: [path] }, noticeAt - 2));
    const kind = o.kind ?? 'dependency_changed';
    const sent = kind === 'dependency_changed'
      ? { kind, from: 'harness', paths: [path], writer_task: o.writer ?? 'T-1', stage: 'in_progress' }
      : o.fromTask ? { kind, from: 'agent_b', from_task_id: o.fromTask, about_paths: [path] } : { kind, from: 'harness', paths: [path] };
    v.apply(ev('message.sent', { message_id: 'm1', to: 'agent_f', to_task_id: 'T-2', text: 'x', priority: 'high', ...sent }, noticeAt - 1));
    if (o.delivered !== false) v.apply(ev('message.delivered', { message_id: 'm1', delivery: 'between_tools', delivered_at: new Date(1_000_000 + noticeAt * 1000).toISOString() }, noticeAt));
    v.apply(ev('task.completed', { task_id: 'T-2', by: 'agent_f' }, 20));
    return v;
  };
  const types = 'src/shared/types.ts';
  assert.deepEqual(surfaced(build(10, types), 'SC-1', ids), { planted: 1, surfaced: 1 }, 'a notice from task 1\'s writes');
  assert.deepEqual(surfaced(build(30, types), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'delivered after the task was done');
  assert.deepEqual(surfaced(build(10, 'README.md'), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'not a planted file');
  assert.deepEqual(surfaced(build(10, 'src/server/migrations/004_status.sql'), 'SC-3', ids), { planted: 1, surfaced: 1 }, 'a directory matches what is in it');
  assert.equal(surfaced(build(10, types), 'SC-4', ids), null);
  assert.equal(surfaced(build(10, types), 'SC-0', ids), null);
  // What doesn't count (validation.md §9).
  assert.deepEqual(surfaced(build(10, types, { synced: true, delivered: false }), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'a sync alone, and a notice never delivered');
  assert.deepEqual(surfaced(build(10, types, { synced: true }), 'SC-1', ids), { planted: 1, surfaced: 1 }, 'the notice still counts beside a sync');
  assert.deepEqual(surfaced(build(10, types, { kind: 'claim_conflict' }), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'harnessd\'s claim_conflict on the scopes');
  assert.deepEqual(surfaced(build(10, types, { writer: 'T-9' }), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'a notice about another task\'s writes');
  assert.deepEqual(surfaced(build(10, types, { editAt: 12 }), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'delivered before task 1 had edited a planted file');
  assert.deepEqual(surfaced(build(10, types, { editPath: 'README.md' }), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'task 1 never edited a planted file');
  assert.deepEqual(surfaced(build(10, types, { kind: 'contract_request', fromTask: 'T-1' }), 'SC-1', ids), { planted: 1, surfaced: 1 }, 'a message from task 1\'s agent');
  assert.deepEqual(surfaced(build(10, types, { kind: 'contract_request', fromTask: 'T-2' }), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'not from task 1');
});

test('D-124: in SC-1 to SC-3 only the first task\'s first integration, failed on its tests, is retried untested', () => {
  const base = { anyIntegrated: false, attempts: 1, testsFailed: true };
  for (const sc of ['SC-1', 'SC-2', 'SC-3']) assert.equal(untestedRetry(sc, base), true, sc);
  for (const sc of ['SC-0', 'SC-4']) assert.equal(untestedRetry(sc, base), false, `${sc}: no planted coupling`);
  assert.equal(untestedRetry('SC-1', { ...base, anyIntegrated: true }), false, 'the other task is already in: it goes back to its agent');
  assert.equal(untestedRetry('SC-1', { ...base, attempts: 2 }), false, 'only the first attempt');
  assert.equal(untestedRetry('SC-1', { ...base, testsFailed: false }), false, 'a conflict or another failure goes back to its agent');
});

test('M6 "reached" at integration: the first attempt of either task whose merge held both tasks\' work, merged cleanly but red', () => {
  let seq = 0;
  const ev = (kind: string, data: Record<string, unknown>): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'p', seq: ++seq, at: new Date(1_000_000 + seq * 1000).toISOString(), actor: { principal: 'x', on_behalf_of: null, device_id: null }, kind, data } as EventMessage);
  const ids = new Map([['T1', 'T-1'], ['T2', 'T-2']]);
  const sha = (c: string) => c.repeat(40);
  const land = (v: ProjectView, task: string, id: string, base: string, head: string, end: Record<string, unknown> | null) => {
    v.apply(ev('land.requested', { land_id: id, task_id: task, device_id: 'd', run_tests: true }));
    v.apply(ev('land.accepted', { land_id: id, task_id: task, base_branch: 'main', base_sha: base, head_sha: head, changed_paths: [] }));
    if (end?.kind === 'land.completed') v.apply(ev('land.completed', { land_id: id, task_id: task, old_base_sha: base, new_base_sha: sha('e'), changed_paths: [] }));
    else if (end) v.apply(ev('land.failed', { land_id: id, task_id: task, reason: end.reason }));
  };
  const run = (steps: [string, string, string | null][]) => {
    const v = new ProjectView('p');
    steps.forEach(([task, id, reason], i) => land(v, task, id, sha(String(i + 1)), sha(String.fromCharCode(97 + i)), reason === null ? { kind: 'land.completed' } : { reason }));
    return harnessAttempts(v, ids);
  };
  const red = run([['T-1', 'l1', null], ['T-2', 'l2', 'tests'], ['T-2', 'l3', null]]);
  assert.deepEqual(red.map((a) => [a.task, a.outcome]), [['T1', 'merged'], ['T2', 'tests_failed'], ['T2', 'merged']]);
  assert.deepEqual(firstAttempt('SC-1', red), { base: sha('2'), head: sha('b') }, 'T2\'s first land, after T1 landed');
  assert.equal(firstAttempt('SC-0', red), null, 'no planted coupling');
  assert.equal(firstAttempt('SC-1', run([['T-2', 'l1', 'tests'], ['T-1', 'l2', null]])), null, 'the other task wasn\'t in yet');
  assert.deepEqual(firstAttempt('SC-1', run([['T-2', 'l1', null], ['T-1', 'l2', 'tests']])), { base: sha('2'), head: sha('b') }, 'the other finishing order: task 2 in first, task 1 red on top of it');
  assert.equal(firstAttempt('SC-1', run([['T-1', 'l1', null], ['T-2', 'l2', 'conflict']])), null, 'a conflict leaves no merge result');
  assert.equal(firstAttempt('SC-1', run([['T-1', 'l1', null], ['T-2', 'l2', null]])), null, 'green at the first attempt');
  assert.equal(firstAttempt('SC-1', run([['T-1', 'l1', null], ['T-2', 'l2', 'error']])), null, 'not a test failure');
});

test('M3\'s conflicts: each task once, whether its first conflict came at a sync or at a land', () => {
  let seq = 0;
  const ev = (kind: string, data: Record<string, unknown>): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'p', seq: ++seq, at: new Date(1_000_000 + seq * 1000).toISOString(), actor: { principal: 'x', on_behalf_of: null, device_id: null }, kind, data } as EventMessage);
  const v = new ProjectView('p');
  v.apply(ev('worktree.sync_conflict', { task_id: 'T-2', conflict_paths: ['a.ts'] }));
  v.apply(ev('worktree.sync_conflict', { task_id: 'T-2', conflict_paths: ['a.ts'] }));
  v.apply(ev('land.failed', { land_id: 'l1', task_id: 'T-2', reason: 'conflict' }));
  v.apply(ev('land.failed', { land_id: 'l2', task_id: 'T-1', reason: 'tests' }));
  v.apply(ev('land.failed', { land_id: 'l3', task_id: 'T-9', reason: 'conflict' }));
  assert.equal(conflictedTasks(v, ['T-1', 'T-2']), 1, 'T-2 once; T-1\'s red tests aren\'t a conflict; T-9 isn\'t a card\'s task');
  v.apply(ev('land.failed', { land_id: 'l4', task_id: 'T-1', reason: 'conflict' }));
  assert.equal(conflictedTasks(v, ['T-1', 'T-2']), 2);
});

test('the harness summary\'s M1 starts when both agents have started work, after worktrees and setup, as the baseline\'s clock does', () => {
  const root = path.join(t.dir, 'm1-start');
  const { repo, sha } = makeRepo(root, { 'a.txt': 'a\n' });
  let seq = 0;
  const ev = (kind: string, data: Record<string, unknown>, at: number): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'p', seq: ++seq, at: new Date(1_000_000 + at * 1000).toISOString(), actor: { principal: 'x', on_behalf_of: null, device_id: null }, kind, data } as EventMessage);
  const v = new ProjectView('p');
  for (const id of ['T-1', 'T-2']) v.apply(ev('task.assigned', { task_id: id, agent_id: `agent_${id}` }, 0));
  v.apply(ev('session.started', { session_id: 's1', task_id: 'T-1', agent_id: 'agent_T-1', device_id: 'd', worktree: '/w1' }, 5));
  v.apply(ev('session.started', { session_id: 's2', task_id: 'T-2', agent_id: 'agent_T-2', device_id: 'd', worktree: '/w2' }, 8));
  v.apply(ev('session.started', { session_id: 's3', task_id: 'T-2', agent_id: 'agent_T-2', device_id: 'd', worktree: '/w2' }, 25)); // a reopen's session: not the start
  v.apply(ev('land.completed', { land_id: 'l1', task_id: 'T-1', old_base_sha: sha, new_base_sha: sha, changed_paths: [] }, 20));
  v.apply(ev('land.completed', { land_id: 'l2', task_id: 'T-2', old_base_sha: sha, new_base_sha: sha, changed_paths: [] }, 30));
  const s = harnessSummary({
    runId: 'r-x', scenario: 'SC-0', phrasing: 1, outcome: 'integrated', capMs: 1_800_000, startedAt: new Date(1_000_000).toISOString(), endedAt: new Date(1_031_000).toISOString(),
    view: v, metrics: computeMetrics(v), ids: new Map([['T1', 'T-1'], ['T2', 'T-2']]), runnerCancels: 0, m10Ms: 0, repo, baseSha: sha, mainSha: sha,
    tasks: [{ key: 'T1', agent: 'a' }, { key: 'T2', agent: 'b' }],
  });
  assert.equal(s.m1_ms, 22_000, 'from the later first session start (8 s) to the last land (30 s), not from the assignment');
});

test('mergeTree is the merge the land step makes; a conflict gives none', () => {
  const root = path.join(t.dir, 'merge-tree');
  const { repo, sha } = makeRepo(root, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const commit = (branch: string, file: string, text: string) => {
    gitIn(repo, 'switch', '-q', '-C', branch, sha);
    fs.writeFileSync(path.join(repo, file), text);
    gitIn(repo, 'commit', '-q', '-am', `${branch}: ${file}`);
    return gitIn(repo, 'rev-parse', 'HEAD');
  };
  const left = commit('left', 'a.txt', 'a2\n');
  const right = commit('right', 'b.txt', 'b2\n');
  const clash = commit('clash', 'a.txt', 'a3\n');
  const tree = mergeTree(repo, left, right);
  gitIn(repo, 'switch', '-q', '-C', 'merged', left);
  gitIn(repo, 'merge', '-q', '--no-ff', '--no-edit', right);
  assert.equal(tree, gitIn(repo, 'rev-parse', 'HEAD^{tree}'), 'the tree of a real --no-ff merge');
  assert.equal(mergeTree(repo, left, clash), null);
});

test('M4\'s commits after the first integration discount the other task\'s own integration', () => {
  const { repo, sha } = makeRepo(path.join(t.dir, 'm4'), { 'a.txt': 'a\n' });
  const commit = (f: string) => { fs.writeFileSync(path.join(repo, f), f); gitIn(repo, 'add', f); gitIn(repo, 'commit', '-q', '-m', f); return gitIn(repo, 'rev-parse', 'HEAD'); };
  commit('t1');
  const two = commit('t2');
  assert.equal(commitsAfterFirst(repo, sha, two, 2), 0);
  assert.equal(commitsAfterFirst(repo, sha, commit('fix'), 2), 1, 'a fix on main after both');
  assert.equal(commitsAfterFirst(repo, sha, sha, 0), 0);
});

test('a task\'s independent diff stops at its first sync: what it did before it could see the other task\'s work (M3)', () => {
  const { repo, sha } = makeRepo(path.join(t.dir, 'indep'), { 'types.ts': 'a\nb\nc\n' });
  const write = (f: string, c: string, msg: string) => { fs.writeFileSync(path.join(repo, f), c); gitIn(repo, 'commit', '-q', '-am', msg); return gitIn(repo, 'rev-parse', 'HEAD'); };
  gitIn(repo, 'checkout', '-q', '-b', 't2');
  const before = write('types.ts', 'a\nb\nc\nd\n', 't2: d');
  gitIn(repo, 'checkout', '-q', 'main');
  write('types.ts', 'A\nb\nc\n', 't1 landed: A');
  gitIn(repo, 'checkout', '-q', 't2');
  gitIn(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main'); // the sync
  const final = write('types.ts', 'A2\nb\nc\nd\n', 't2 builds on t1\'s line');
  assert.equal(independentTip(repo, sha, final), before);
  assert.equal(independentTip(repo, sha, before), before, 'never synced: its final commit');
  const dir = path.join(t.dir, 'indep-rec');
  writeDiffs(dir, repo, sha, gitIn(repo, 'rev-parse', 'main'), [{ key: 'T2', commit: final }, { key: 'T3', commit: null }]);
  const indep = fs.readFileSync(path.join(dir, 'diffs/T2.independent.patch'), 'utf8');
  assert.match(indep, /^\+d$/m);
  assert.doesNotMatch(indep, /A2|^\+A$/m, 'not the line it changed after seeing t1\'s');
  assert.match(fs.readFileSync(path.join(dir, 'diffs/T2.patch'), 'utf8'), /^\+A2$/m, 'the final patch has everything');
  assert.match(indep, /^--- a\/types\.ts$/m, 'fixed prefixes, whatever the user\'s git config');
  assert.equal(fs.readFileSync(path.join(dir, 'diffs/T3.independent.patch'), 'utf8'), '');
});

/** Runs the baseline arm on a two-task repo whose test command is `testCommand`; `slow` delays a task's every model response. */
async function baselineRun(name: string, testCommand: string, capMs: number, o: { scenario?: string; slow?: Record<string, number> } = {}) {
  const root = path.join(t.dir, name);
  const home = tempHome(root);
  const { repo, sha } = makeRepo(root, { 'harness.yaml': `test:\n  command: "${testCommand}"\n`, 'src/a.ts': 'export {}\n' });
  const raw = { device_id: 'dev_t', principal: 'human_t', server_url: 'wss://example.invalid', limits: { port_range: [32100, 32199] }, projects: [{ id: 'prj_t', repo }] };
  fs.writeFileSync(home.config, toToml(raw)); // the launcher reads it, as harnessd would
  const config = parseConfig(raw, TOKEN);
  const mock = await startMock();
  const rec = new Recorder(path.join(root, 'record'));
  const tasks = ['backend', 'frontend'].map((agent, i) => ({ key: `T${i + 1}`, agent, title: `Task ${i + 1}`, scope: [], phrasings: ['x'] }));
  try {
    const r = await runBaseline({
      scenario: o.scenario ?? 'SC-0', tasks, phrasing: 1, capMs, rec, root, repo, home, config, provider: null, mockUrl: mock.url, launch: 'headless', autoIntegrate: true,
      prompt: (task, wt) => [`${task.title}.`, ...(o.slow?.[task.key] ? [`#SLOW ${o.slow[task.key]}`] : []),
        `#STEP Write ${JSON.stringify({ file_path: `${wt}/${task.agent}.md`, content: `${task.key}\n` })}`, '#STEP TEXT Done.'].join('\n'),
      stopRequested: () => false, console: null, harnessRoot: path.resolve(import.meta.dirname, '..'),
    });
    return { r, rec, repo, sha, mock };
  } finally {
    await mock.close();
  }
}

test('the baseline arm: both agents work in their own worktrees, and each task is merged into main only with green tests', async () => {
  const { r, rec, repo, sha, mock } = await baselineRun('green', 'true', 120_000);
  assert.equal(r.outcome, 'integrated');
  const s = checkSummary({ ...r.summary, run_id: 'r-x', phrasing: 1, cap_ms: 120_000, started_at: 'a', ended_at: 'b', void: null });
  assert.equal(s.arm, 'baseline');
  assert.deepEqual(gitIn(repo, 'ls-tree', '--name-only', 'main').split('\n').sort(), ['backend.md', 'frontend.md', 'harness.yaml', 'src']);
  assert.equal(gitIn(repo, 'rev-list', '--first-parent', '--count', `${sha}..main`), '2', 'one merge per task');
  assert.ok(s.m1_ms! > 0 && s.m4.commits_after_first === 0 && s.m4.ms_to_green! >= 0);
  assert.deepEqual([s.m3_conflicts, s.m9a, s.m5, s.m5c, s.surfaced], [0, 0, 0, 2, null], 'no relays: the cards were the only messages; two merges');
  assert.ok(s.m8.input > 0 && s.m8.output > 0, 'tokens from the transcripts');
  assert.ok(mock.log.filter((e) => e.kind === 'main').every((e) => e.authOk), 'API-key auth only');
  const integrations = timeline(rec).filter((e) => e.what === 'integration');
  assert.deepEqual(integrations.map((e) => e.outcome), ['merged', 'merged']);
  assert.deepEqual(r.commits.map((c) => c.key), ['T1', 'T2']);
});

test('negative control: tests that never pass leave main where it was, count once as M9a per task, and stop the auto coordinator', async () => {
  const { r, repo, sha } = await baselineRun('red', 'false', 150_000);
  assert.equal(r.outcome, 'stopped', 'three failed attempts on one task');
  assert.equal(gitIn(repo, 'rev-parse', 'main'), sha, 'main never moved');
  assert.equal(r.summary.m1_ms, null);
  assert.ok(r.summary.m9a >= 1 && r.summary.m9a <= 2, `only first attempts count: ${r.summary.m9a}`);
  assert.ok(r.summary.m5 >= 1, 'the fix requests typed into the terminal are messages to the agent');
});

test('D-124 in the baseline arm (SC-1): the first task goes in untested after red tests; the second must be green, and its red first attempt is kept for grading', async () => {
  // T2 answers slowly, so T1 finishes and is integrated first, as the assertions below require.
  const { r, rec, repo, sha } = await baselineRun('coupled', 'false', 180_000, { scenario: 'SC-1', slow: { T2: 4000 } });
  assert.equal(r.outcome, 'stopped', 'T2 can never pass: three attempts, then the auto coordinator stops');
  const integrations = timeline(rec).filter((e) => e.what === 'integration');
  const t1 = integrations.filter((e) => e.task === 'T1').map((e) => [e.outcome, e.tests]);
  assert.deepEqual(t1, [['tests_failed', true], ['merged', false]], 'T1: red, then in untested');
  const firstT2 = integrations.findIndex((e) => e.task === 'T2');
  assert.ok(firstT2 > integrations.findIndex((e) => e.task === 'T1' && e.outcome === 'merged'), 'precondition: T1 was in before T2\'s first attempt');
  assert.ok(integrations.filter((e) => e.task === 'T2').every((e) => e.outcome === 'tests_failed' && e.tests === true), 'T2 is never let in untested');
  assert.equal(gitIn(repo, 'rev-list', '--first-parent', '--count', `${sha}..main`), '1', 'main moved once: T1');
  assert.equal(r.summary.m9a, 2, 'each task\'s first attempt was red');
  const first = firstAttempt('SC-1', r.attempts);
  assert.ok(first, 'T2\'s red first attempt, after T1 was in');
  const tree = mergeTree(repo, first.base, first.head)!;
  assert.deepEqual(gitIn(repo, 'ls-tree', '--name-only', tree).split('\n').sort(), ['backend.md', 'frontend.md', 'harness.yaml', 'src'], 'the merge it tested has both tasks\' work');
});
