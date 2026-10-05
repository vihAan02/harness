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
import { commitsAfterFirst, independentTip, surfaced, writeDiffs } from '../scripts/ab/summarize.ts';
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

test('P1\'s "surfaced": a notice naming a planted file, delivered before the affected task is done; nothing for SC-0 and SC-4', () => {
  let seq = 0;
  const ev = (kind: string, data: Record<string, unknown>, at: number): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'p', seq: ++seq, at: new Date(1_000_000 + at * 1000).toISOString(), actor: { principal: 'x', on_behalf_of: null, device_id: null }, kind, data } as EventMessage);
  const ids = new Map([['T1', 'T-1'], ['T2', 'T-2']]);
  const build = (noticeAt: number, path: string) => {
    const v = new ProjectView('p');
    v.apply(ev('task.created', { task_id: 'T-2', title: 'Front', scope: [], owner_human_id: 'h' }, 0));
    v.apply(ev('message.sent', { message_id: 'm1', kind: 'dependency_changed', from: 'harness', to: 'agent_f', to_task_id: 'T-2', paths: [path], text: 'x', priority: 'high' }, noticeAt - 1));
    v.apply(ev('message.delivered', { message_id: 'm1', delivery: 'between_tools', delivered_at: new Date(1_000_000 + noticeAt * 1000).toISOString() }, noticeAt));
    v.apply(ev('task.completed', { task_id: 'T-2', by: 'agent_f' }, 20));
    return v;
  };
  assert.deepEqual(surfaced(build(10, 'src/shared/types.ts'), 'SC-1', ids), { planted: 1, surfaced: 1 });
  assert.deepEqual(surfaced(build(30, 'src/shared/types.ts'), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'delivered after the task was done');
  assert.deepEqual(surfaced(build(10, 'README.md'), 'SC-1', ids), { planted: 1, surfaced: 0 }, 'not a planted file');
  assert.deepEqual(surfaced(build(10, 'src/server/migrations/004_status.sql'), 'SC-3', ids), { planted: 1, surfaced: 1 }, 'a directory matches what is in it');
  assert.equal(surfaced(build(10, 'src/shared/types.ts'), 'SC-4', ids), null);
  assert.equal(surfaced(build(10, 'src/shared/types.ts'), 'SC-0', ids), null);
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

/** Runs the baseline arm on a two-task repo whose test command is `testCommand`. */
async function baselineRun(name: string, testCommand: string, capMs: number) {
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
      scenario: 'SC-0', tasks, phrasing: 1, capMs, rec, root, repo, home, config, provider: null, mockUrl: mock.url, launch: 'headless', autoIntegrate: true,
      prompt: (task, wt) => [`${task.title}.`, `#STEP Write ${JSON.stringify({ file_path: `${wt}/${task.agent}.md`, content: `${task.key}\n` })}`, '#STEP TEXT Done.'].join('\n'),
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
