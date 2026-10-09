// The fake GitHub behaves like GitHub where the pilot's later cards rely on it (D-114, D-115; docs/protocol.md §11):
// Git over HTTPS through repo-local trust and credentials only, PRs whose head follows pushes, mergeability (dirty,
// behind under strict, blocked by checks or reviews, unknown while computing), the squash merge with its guards,
// faults and stale reads, the rules endpoint; and startPilotStack brings two device-key harnessds up against it.
// No vendor CLI or model runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { git as harnessdGit } from '../../packages/daemon/src/git.ts';
import { tempDir } from '../../packages/daemon/test/fixtures.ts';
import { TEST_DATABASE_URL } from '../../packages/server/test/helpers.ts';
import pg from 'pg';
import { FakeGitHub, REQUIRED_CHECKS } from '../fake-github.ts';
import { gitAsync, makeRemotePair, startPilotStack } from '../support.ts';

const FILES = { 'README.md': '# harness\n', 'src/app.ts': 'export const v = 1;\n' };
const BRANCH = 'harness/task/T-1';

/** A fake with two clones; `api` calls its REST API with the token unless told otherwise. */
async function setup() {
  const fake = await FakeGitHub.start({ files: FILES });
  const t = tempDir('fakegh-test');
  const pair = await makeRemotePair(t.dir, fake);
  const api = async (method: string, p: string, body?: unknown, authorization: string | null = `Bearer ${fake.token}`) => {
    const r = await fetch(`${fake.apiUrl}${p}`, {
      method, headers: { ...(authorization ? { authorization } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() as any };
  };
  const repoPath = `/repos/${fake.owner}/${fake.repo}`;
  /** Commits `files` on `branch` in clone `repo` (when new, from a fresh origin/main) and pushes it with harnessd's own Git. */
  const pushBranch = async (repo: string, branch: string, files: Record<string, string>, o: { from?: string } = {}) => {
    const exists = (await gitAsync(repo, 'branch', '--list', branch)) !== '';
    if (!exists) await harnessdGit(repo, 'fetch', '-q', 'origin');
    await gitAsync(repo, 'checkout', '-q', ...(exists ? [branch] : ['-b', branch, o.from ?? 'origin/main']));
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
      fs.writeFileSync(path.join(repo, name), content);
    }
    await gitAsync(repo, 'add', '-A');
    await gitAsync(repo, 'commit', '-q', '-m', `change ${Object.keys(files).join(', ')}`);
    await harnessdGit(repo, 'push', '-q', 'origin', `${branch}:refs/heads/${branch}`);
    return gitAsync(repo, 'rev-parse', 'HEAD');
  };
  const openPr = async (head = BRANCH) => {
    const r = await api('POST', `${repoPath}/pulls`, { title: `PR for ${head}`, body: 'the task', head: `${fake.owner}:${head}`, base: 'main' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.number as number;
  };
  const pr = async (n: number) => (await api('GET', `${repoPath}/pulls/${n}`)).body;
  const stop = async () => { await fake.close(); t.cleanup(); };
  return { fake, t, a: pair.a.repo, b: pair.b.repo, api, repoPath, pushBranch, openPr, pr, stop };
}

test('Git over HTTPS: clone, fetch and push through repo-local trust and credentials, with no token in the URL', async () => {
  const s = await setup();
  try {
    for (const repo of [s.a, s.b]) {
      const url = new URL(await gitAsync(repo, 'remote', 'get-url', 'origin'));
      assert.equal(url.href, s.fake.gitUrl);
      assert.equal(url.username + url.password, '', 'no userinfo in the remote');
      assert.ok(!url.href.includes(s.fake.token));
    }
    // harnessd's restricted-env Git (PATH, HOME, GIT_TERMINAL_PROMPT=0, LC_ALL=C, hooks off) pushes and fetches.
    const head = await s.pushBranch(s.a, BRANCH, { 'src/app.ts': 'export const v = 2;\n' });
    assert.equal(await s.fake.tip(BRANCH), head);
    await harnessdGit(s.b, 'fetch', '-q', 'origin');
    assert.equal(await harnessdGit(s.b, 'rev-parse', `origin/${BRANCH}`), head);
    assert.ok(s.fake.log.some((e) => e.server === 'git' && e.status === 401), 'git asked for credentials only after a 401');

    // Negative controls, with no user or system Git config: no credentials → 401; credentials but no CA → TLS refuses.
    const bare = { env: { PATH: process.env.PATH ?? '', HOME: s.t.dir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } };
    const run = (...args: string[]) => new Promise<string>((resolve) =>
      execFile('git', args, { ...bare, cwd: s.t.dir }, (err, _out, stderr) => resolve(err ? stderr : 'ok')));
    const before = s.fake.log.filter((e) => e.status === 401).length;
    assert.match(await run('-c', `http.sslCAInfo=${s.fake.caFile}`, 'ls-remote', s.fake.gitUrl), /Authentication failed|could not read Username|terminal prompts disabled/i);
    assert.ok(s.fake.log.filter((e) => e.status === 401).length > before);
    const helper = `!f() { echo username=x; echo password=${s.fake.token}; }; f`;
    assert.match(await run('-c', `credential.helper=${helper}`, 'ls-remote', s.fake.gitUrl), /SSL|certificate/i);
    assert.equal(await run('-c', `http.sslCAInfo=${s.fake.caFile}`, '-c', `credential.helper=${helper}`, 'ls-remote', s.fake.gitUrl), 'ok');

    // The base takes changes only through a PR, as with a ruleset's pull_request rule (GH013).
    await gitAsync(s.a, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(s.a, 'README.md'), 'direct\n');
    await gitAsync(s.a, 'commit', '-q', '-am', 'direct to main');
    await assert.rejects(harnessdGit(s.a, 'push', '-q', 'origin', 'main'), /GH013/);
    assert.equal(await s.fake.baseTip(), await gitAsync(s.a, 'rev-parse', 'origin/main'));
  } finally {
    await s.stop();
  }
});

test('PRs: create, list and get; head.sha follows pushes; validation errors; auth and unknown routes', async () => {
  const s = await setup();
  try {
    const base = await s.fake.baseTip();
    const head = await s.pushBranch(s.a, BRANCH, { 'src/app.ts': 'export const v = 2;\n' });
    const created = await s.api('POST', `${s.repoPath}/pulls`, { title: 'T-1', body: 'the task', head: `${s.fake.owner}:${BRANCH}`, base: 'main' });
    assert.equal(created.status, 201);
    const n = created.body.number;
    assert.equal(n, 1);
    assert.equal(created.body.mergeable, null, 'not computed yet at creation');
    assert.deepEqual([created.body.head.ref, created.body.head.sha, created.body.head.repo.full_name], [BRANCH, head, 'vihAan02/harness']);
    assert.deepEqual([created.body.base.ref, created.body.base.sha], ['main', base]);
    assert.equal(created.body.html_url, `${s.fake.webUrl}/vihAan02/harness/pull/1`);

    const dup = await s.api('POST', `${s.repoPath}/pulls`, { title: 'again', head: BRANCH, base: 'main' });
    assert.equal(dup.status, 422);
    assert.match(dup.body.errors[0].message, /A pull request already exists for vihAan02:harness\/task\/T-1/);
    assert.equal((await s.api('POST', `${s.repoPath}/pulls`, { title: 'x', head: 'no-such-branch', base: 'main' })).status, 422);
    await harnessdGit(s.a, 'push', '-q', 'origin', 'origin/main:refs/heads/empty');
    assert.match((await s.api('POST', `${s.repoPath}/pulls`, { title: 'x', head: 'empty', base: 'main' })).body.errors[0].message, /No commits between main and empty/);

    const listed = await s.api('GET', `${s.repoPath}/pulls?head=${encodeURIComponent(`vihAan02:${BRANCH}`)}&state=open`);
    assert.deepEqual(listed.body.map((p: any) => p.number), [1]);
    assert.ok(!('mergeable_state' in listed.body[0]) && !('merged' in listed.body[0]), 'the list carries no mergeability, as on GitHub');
    assert.deepEqual((await s.api('GET', `${s.repoPath}/pulls?state=closed`)).body, []);
    assert.deepEqual((await s.api('GET', `${s.repoPath}/pulls?head=someone-else:${encodeURIComponent(BRANCH)}`)).body, []);

    let got = await s.pr(n);
    assert.deepEqual([got.state, got.merged, got.mergeable, got.mergeable_state, got.head.sha, got.merge_commit_sha], ['open', false, true, 'clean', head, null]);
    const head2 = await s.pushBranch(s.a, BRANCH, { 'src/more.ts': 'export {}\n' });
    got = await s.pr(n);
    assert.equal(got.head.sha, head2, 'head.sha is the head branch\'s live tip');
    assert.deepEqual((await s.api('GET', `${s.repoPath}/branches/${encodeURIComponent(BRANCH)}`)).body.commit, { sha: head2 });
    assert.equal((await s.api('GET', `${s.repoPath}/branches/nope`)).status, 404);

    assert.equal((await s.api('GET', `${s.repoPath}/pulls/1`, undefined, null)).status, 401);
    assert.equal((await s.api('GET', `${s.repoPath}/pulls/1`, undefined, 'Bearer wrong')).status, 401);
    assert.equal((await s.api('GET', `${s.repoPath}/pulls/1`, undefined, `token ${s.fake.token}`)).status, 200);
    assert.deepEqual(await s.api('GET', `${s.repoPath}/issues`), { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } });
    assert.equal((await s.api('GET', '/repos/someone/else/pulls/1')).status, 404);
    assert.equal((await s.api('GET', `${s.repoPath}/pulls/99`)).status, 404);
  } finally {
    await s.stop();
  }
});

test('mergeable_state: behind under strict after a base move, clean once main is merged in; dirty on a conflict', async () => {
  const s = await setup();
  try {
    await s.pushBranch(s.a, BRANCH, { 'src/app.ts': 'export const v = 2;\n' });
    const n = await s.openPr();
    const moved = await s.fake.pushToBase({ 'docs/other.md': 'a human merged this\n' }, 'Another PR (#7)');
    let got = await s.pr(n);
    assert.equal(got.base.sha, moved, 'base.sha is the live base tip');
    assert.deepEqual([got.mergeable, got.mergeable_state], [true, 'behind']);
    s.fake.strict = false;
    assert.equal((await s.pr(n)).mergeable_state, 'clean', 'not behind without the strict policy');
    s.fake.strict = true;
    // Merging main into the head brings it up to date.
    await harnessdGit(s.a, 'fetch', '-q', 'origin');
    await gitAsync(s.a, 'merge', '-q', '--no-edit', 'origin/main');
    await harnessdGit(s.a, 'push', '-q', 'origin', BRANCH);
    got = await s.pr(n);
    assert.equal(got.head.sha, await gitAsync(s.a, 'rev-parse', 'HEAD'));
    assert.equal(got.mergeable_state, 'clean');
    // A conflicting change on the base: dirty, not mergeable.
    await s.fake.pushToBase({ 'src/app.ts': 'export const v = 3;\n' }, 'Conflicting PR (#8)');
    got = await s.pr(n);
    assert.deepEqual([got.mergeable, got.mergeable_state], [false, 'dirty']);
  } finally {
    await s.stop();
  }
});

test('the squash merge: the sha guard, squash only, not when behind; one parent, the head\'s tree, the base moved, the branch deleted', async () => {
  const s = await setup();
  try {
    const head = await s.pushBranch(s.a, BRANCH, { 'src/app.ts': 'export const v = 2;\n', 'src/new.ts': 'export {}\n' });
    const n = await s.openPr();
    const merge = (body: Record<string, unknown>) => s.api('PUT', `${s.repoPath}/pulls/${n}/merge`, body);
    assert.deepEqual(await merge({ sha: 'f'.repeat(40), merge_method: 'squash' }), { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } });
    assert.equal((await merge({ sha: head, merge_method: 'merge' })).status, 405);
    assert.equal((await merge({ sha: head, merge_method: 'rebase' })).status, 405);
    assert.equal((await merge({ sha: head })).status, 405, 'the default method is merge, which a squash-only repo refuses');
    const old = await s.fake.pushToBase({ 'docs/other.md': 'x\n' }, 'Another PR (#7)');
    assert.deepEqual(await merge({ sha: head, merge_method: 'squash' }), { status: 405, body: { message: 'Pull Request is not mergeable' } }, 'behind under strict');
    assert.equal(await s.fake.baseTip(), old, 'nothing merged');

    await harnessdGit(s.a, 'fetch', '-q', 'origin');
    await gitAsync(s.a, 'merge', '-q', '--no-edit', 'origin/main');
    await harnessdGit(s.a, 'push', '-q', 'origin', BRANCH);
    const tip = await gitAsync(s.a, 'rev-parse', 'HEAD');
    const r = await merge({ sha: tip, merge_method: 'squash', commit_title: 'T-1: the task (#1)', commit_message: 'Harness-Task: T-1' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.merged, r.body.message], [true, 'Pull Request successfully merged']);
    const m = r.body.sha as string;
    assert.equal(await s.fake.git(['rev-list', '--parents', '-n', '1', m]), `${m} ${old}`, 'one parent: the old base tip');
    assert.equal(await s.fake.git(['rev-parse', `${m}^{tree}`]), await s.fake.git(['rev-parse', `${tip}^{tree}`]), 'the head\'s tree, since the head contains the base');
    assert.equal((await s.fake.git(['log', '-1', '--format=%B', m])).trimEnd(), 'T-1: the task (#1)\n\nHarness-Task: T-1');
    assert.equal(await s.fake.git(['log', '-1', '--format=%an <%ae>|%cn <%ce>', m]), 'Fake User <fake-user@users.noreply.github.com>|Fake User <fake-user@users.noreply.github.com>');
    assert.equal(await s.fake.baseTip(), m);
    assert.equal(await s.fake.tip(BRANCH), null, 'the head branch is deleted');
    const got = await s.pr(n);
    assert.deepEqual([got.state, got.merged, got.merge_commit_sha, got.head.sha, got.base.sha], ['closed', true, m, tip, old]);
    assert.equal((await merge({ sha: tip, merge_method: 'squash' })).status, 405, 'already merged');
    // A clone sees the merge, and the branch gone.
    await harnessdGit(s.b, 'fetch', '-q', '--prune', 'origin');
    assert.equal(await harnessdGit(s.b, 'rev-parse', 'origin/main'), m);
    assert.equal(await harnessdGit(s.b, 'branch', '-r', '--list', `origin/${BRANCH}`), '');
  } finally {
    await s.stop();
  }
});

test('merge faults: a dropped response after the merge, a 502 with nothing merged, a slow merge, stale reads', async () => {
  const s = await setup();
  try {
    const merge = (n: number, sha: string, signal?: AbortSignal) =>
      fetch(`${s.fake.apiUrl}${s.repoPath}/pulls/${n}/merge`, { method: 'PUT', headers: { authorization: `Bearer ${s.fake.token}` }, body: JSON.stringify({ sha, merge_method: 'squash' }), ...(signal ? { signal } : {}) });

    // drop: GitHub merged, the caller never hears.
    const h1 = await s.pushBranch(s.a, 'harness/task/T-1', { 'one.txt': '1\n' });
    const n1 = await s.openPr('harness/task/T-1');
    s.fake.mergeFault = 'drop';
    await assert.rejects(merge(n1, h1), /fetch failed/);
    const p1 = await s.pr(n1);
    assert.deepEqual([p1.merged, p1.state], [true, 'closed']);
    assert.equal(await s.fake.baseTip(), p1.merge_commit_sha);
    assert.equal(s.fake.log.findLast((e) => e.method === 'PUT')!.status, 0, 'logged with no response');

    // error5xx: nothing merged; the fault is spent, so the retry merges.
    const h2 = await s.pushBranch(s.a, 'harness/task/T-2', { 'two.txt': '2\n' });
    const n2 = await s.openPr('harness/task/T-2');
    const before = await s.fake.baseTip();
    s.fake.mergeFault = 'error5xx';
    assert.equal((await merge(n2, h2)).status, 502);
    assert.deepEqual([(await s.pr(n2)).merged, await s.fake.baseTip()], [false, before]);
    // staleReads: after the merge, the next two reads still show it open.
    s.fake.staleReads = 2;
    assert.equal((await merge(n2, h2)).status, 200);
    for (let i = 0; i < 2; i++) {
      const stale = await s.pr(n2);
      assert.deepEqual([stale.state, stale.merged, stale.merge_commit_sha, stale.mergeable_state], ['open', false, null, 'clean'], `stale read ${i + 1}`);
    }
    assert.equal((await s.pr(n2)).merged, true);
    s.fake.staleReads = 0;

    // delay: the caller gives up (outcome unknown); GitHub still merges afterwards.
    const h3 = await s.pushBranch(s.a, 'harness/task/T-3', { 'three.txt': '3\n' });
    const n3 = await s.openPr('harness/task/T-3');
    s.fake.mergeFault = { delayMs: 1000 };
    await assert.rejects(merge(n3, h3, AbortSignal.timeout(50)), (e: Error) => e.name === 'TimeoutError');
    assert.equal(s.fake.prs().find((p) => p.number === n3)!.merged, false, 'not merged when the caller gave up');
    for (const end = Date.now() + 10_000; !s.fake.prs().find((p) => p.number === n3)!.merged; await new Promise((r) => setTimeout(r, 25))) {
      if (Date.now() > end) throw new Error('timed out waiting for the delayed merge');
    }
    assert.equal(await s.fake.baseTip(), (await s.pr(n3)).merge_commit_sha);
  } finally {
    await s.stop();
  }
});

test('mergeableUnknownPolls: the first reads after a push or a base move are unknown', async () => {
  const s = await setup();
  try {
    s.fake.mergeableUnknownPolls = 2;
    await s.pushBranch(s.a, BRANCH, { 'src/app.ts': 'export const v = 2;\n' });
    const n = await s.openPr();
    const states = async (k: number) => { const out: unknown[] = []; for (let i = 0; i < k; i++) { const p = await s.pr(n); out.push([p.mergeable, p.mergeable_state]); } return out; };
    assert.deepEqual(await states(3), [[null, 'unknown'], [null, 'unknown'], [true, 'clean']]);
    await s.pushBranch(s.a, BRANCH, { 'src/b.ts': 'export {}\n' });
    assert.deepEqual(await states(3), [[null, 'unknown'], [null, 'unknown'], [true, 'clean']]);
    await s.fake.pushToBase({ 'docs/x.md': 'x\n' }, 'base moves');
    assert.deepEqual(await states(3), [[null, 'unknown'], [null, 'unknown'], [true, 'behind']]);
  } finally {
    await s.stop();
  }
});

test('checks and reviews: check runs per commit, required checks and required reviews block, stale approvals don\'t count', async () => {
  const s = await setup();
  try {
    const head = await s.pushBranch(s.a, BRANCH, { 'src/app.ts': 'export const v = 2;\n' });
    const n = await s.openPr();
    const runs = (ref: string) => s.api('GET', `${s.repoPath}/commits/${encodeURIComponent(ref)}/check-runs`);
    const all = (await runs(head)).body;
    assert.equal(all.total_count, 3);
    assert.deepEqual(all.check_runs.map((c: any) => [c.name, c.status, c.conclusion]), REQUIRED_CHECKS.map((c) => [c, 'completed', 'success']));
    assert.equal((await runs(BRANCH)).body.total_count, 3, 'a branch name resolves to its tip');
    assert.equal((await runs('0'.repeat(40))).status, 422);

    s.fake.setChecks(head, { guard: 'success', 'unit-linux': 'failure', 'full-macos': 'success' });
    assert.equal((await s.pr(n)).mergeable_state, 'blocked');
    assert.equal((await s.api('PUT', `${s.repoPath}/pulls/${n}/merge`, { sha: head, merge_method: 'squash' })).status, 405);
    s.fake.setChecks(head, { guard: 'success', 'unit-linux': 'in_progress', 'full-macos': 'success' });
    assert.deepEqual((await runs(head)).body.check_runs.find((c: any) => c.name === 'unit-linux'), { id: 2, name: 'unit-linux', head_sha: head, status: 'in_progress', conclusion: null });
    assert.equal((await s.pr(n)).mergeable_state, 'blocked');
    s.fake.setChecks(head, { guard: 'success', 'unit-linux': 'success', 'full-macos': 'skipped', lint: 'failure' });
    assert.equal((await s.pr(n)).mergeable_state, 'clean', 'skipped passes; a check that isn\'t required doesn\'t block');

    s.fake.requireReviewFrom = ['human-b'];
    assert.equal((await s.pr(n)).mergeable_state, 'blocked');
    assert.deepEqual((await s.api('GET', `${s.repoPath}/pulls/${n}/reviews`)).body, []);
    s.fake.addReview(n, { login: 'human-b', state: 'APPROVED', commit_id: head });
    const reviews = (await s.api('GET', `${s.repoPath}/pulls/${n}/reviews`)).body;
    assert.deepEqual(reviews.map((r: any) => [r.user.login, r.state, r.commit_id]), [['human-b', 'APPROVED', head]]);
    assert.equal((await s.pr(n)).mergeable_state, 'clean');
    s.fake.addReview(n, { login: 'human-b', state: 'CHANGES_REQUESTED', commit_id: head });
    assert.equal((await s.pr(n)).mergeable_state, 'blocked', 'the latest review counts');
    s.fake.addReview(n, { login: 'human-b', state: 'APPROVED', commit_id: head });
    // A push dismisses the approval: it was for the old head. The new head's checks come from '*' (all success).
    const head2 = await s.pushBranch(s.a, BRANCH, { 'src/b.ts': 'export {}\n' });
    assert.equal((await s.pr(n)).mergeable_state, 'blocked');
    s.fake.addReview(n, { login: 'human-b', state: 'APPROVED', commit_id: head2 });
    assert.equal((await s.pr(n)).mergeable_state, 'clean');
  } finally {
    await s.stop();
  }
});

test('rules: the base\'s protections as GitHub lists them; overriding them changes what blocks a merge and a push', async () => {
  const s = await setup();
  try {
    const rules = async (branch: string) => (await s.api('GET', `${s.repoPath}/rules/branches/${encodeURIComponent(branch)}`)).body;
    const main = await rules('main');
    assert.deepEqual(main.map((r: any) => r.type), ['pull_request', 'required_status_checks', 'non_fast_forward', 'required_linear_history']);
    assert.deepEqual(main[0].parameters.allowed_merge_methods, ['squash']);
    assert.equal(main[1].parameters.strict_required_status_checks_policy, true);
    assert.deepEqual(main[1].parameters.required_status_checks, [{ context: 'guard' }, { context: 'unit-linux' }, { context: 'full-macos' }]);
    assert.equal(main[0].ruleset_source, 'vihAan02/harness');
    assert.deepEqual(await rules(BRANCH), []);
    s.fake.strict = false;
    assert.equal((await rules('main'))[1].parameters.strict_required_status_checks_policy, false);
    s.fake.strict = true;
    s.fake.requireReviewFrom = ['human-b'];
    assert.equal((await rules('main'))[0].parameters.required_approving_review_count, 1);
    s.fake.requireReviewFrom = undefined;

    // Protections missing: no required checks, and no PR requirement, so failing checks don't block and the base takes a push.
    s.fake.rules = [{ type: 'non_fast_forward' }];
    assert.deepEqual((await rules('main')).map((r: any) => r.type), ['non_fast_forward']);
    const head = await s.pushBranch(s.a, BRANCH, { 'src/app.ts': 'export const v = 2;\n' });
    const n = await s.openPr();
    s.fake.setChecks(head, { guard: 'failure' });
    assert.equal((await s.pr(n)).mergeable_state, 'clean');
    await gitAsync(s.a, 'checkout', '-q', '-B', 'main', 'origin/main');
    fs.writeFileSync(path.join(s.a, 'README.md'), 'direct\n');
    await gitAsync(s.a, 'commit', '-q', '-am', 'direct to main');
    await harnessdGit(s.a, 'push', '-q', 'origin', 'main');
    assert.equal(await s.fake.baseTip(), await gitAsync(s.a, 'rev-parse', 'HEAD'));
    s.fake.rules = null;
    assert.equal((await rules('main')).length, 4, 'back to the defaults');
  } finally {
    await s.stop();
  }
});

test('externalMerge: a human merges on GitHub past failing checks, but not past a conflict', async () => {
  const s = await setup();
  try {
    const head = await s.pushBranch(s.a, BRANCH, { 'src/app.ts': 'export const v = 2;\n' });
    const n = await s.openPr();
    s.fake.setChecks(head, { guard: 'failure' });
    const old = await s.fake.baseTip();
    const m = await s.fake.externalMerge(n);
    assert.equal(await s.fake.git(['rev-parse', `${m}^`]), old);
    assert.equal(await s.fake.git(['log', '-1', '--format=%s', m]), `PR for ${BRANCH} (#${n})`, 'GitHub\'s default squash title');
    const got = await s.pr(n);
    assert.deepEqual([got.merged, got.merge_commit_sha], [true, m]);

    await s.pushBranch(s.a, 'harness/task/T-2', { 'src/app.ts': 'export const v = 9;\n' }, { from: old });
    const n2 = await s.openPr('harness/task/T-2');
    await assert.rejects(s.fake.externalMerge(n2), /conflicts/);
    assert.equal(await s.fake.baseTip(), m);
    // Closed unmerged by a human: it can't be merged, and it lists as closed.
    await s.fake.closePr(n2);
    const closed = await s.pr(n2);
    assert.deepEqual([closed.state, closed.merged, closed.merge_commit_sha], ['closed', false, null]);
    assert.equal((await s.api('PUT', `${s.repoPath}/pulls/${n2}/merge`, { merge_method: 'squash' })).status, 405);
    assert.deepEqual((await s.api('GET', `${s.repoPath}/pulls?state=closed`)).body.map((p: any) => [p.number, p.merged_at !== null]), [[n2, false], [n, true]]);
  } finally {
    await s.stop();
  }
});

test('startPilotStack: both harnessds come up over device keys, both humans can send commands, and it stops cleanly', async () => {
  const s = await startPilotStack({ files: FILES });
  let stopped = false;
  try {
    assert.equal(s.a.daemon.linkState, 'connected');
    assert.equal(s.b.daemon.linkState, 'connected');
    assert.equal(s.a.config.projects[0]!.integration, 'github');
    assert.equal(s.a.config.projects[0]!.remote, s.fake.gitUrl);
    // Each clone fetches through its own repo config, with harnessd's Git.
    assert.equal(await harnessdGit(s.b.repo, 'ls-remote', 'origin', 'refs/heads/main'), `${await s.fake.baseTip()}\trefs/heads/main`);
    const ra = await s.a.command('agent.create', { name: 'agent/a1', vendor: 'claude' });
    const rb = await s.b.command('agent.create', { name: 'agent/b1', vendor: 'claude' });
    const owners = (await s.db.pool.query<{ id: string; accountable_human_id: string }>('SELECT id, accountable_human_id FROM agent_principals ORDER BY name')).rows;
    assert.deepEqual(owners, [{ id: ra.agent_id, accountable_human_id: 'human_a' }, { id: rb.agent_id, accountable_human_id: 'human_b' }]);
    // Both harnessds see both agents from the log.
    await s.until(() => [s.a, s.b].every((x) => x.daemon.view(s.project).agents.has(ra.agent_id!) && x.daemon.view(s.project).agents.has(rb.agent_id!)), 10_000, 'both agents in both views');
    const dir = s.t.dir;
    const schema = s.db.schema;
    await s.stop();
    stopped = true;
    assert.equal(fs.existsSync(dir), false, 'temp dirs removed');
    const probe = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await probe.connect();
    try {
      assert.equal((await probe.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [schema])).rowCount, 0, 'schema dropped');
    } finally {
      await probe.end();
    }
  } finally {
    if (!stopped) await s.stop();
  }
});
