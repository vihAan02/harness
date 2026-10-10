// The publish gate (D-114, TH-24), CODEOWNERS lookups, and a task PR's text: what a push to the public repo may carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitIn, makeRepo, tempDir } from './fixtures.ts';
import { deniedPath, publishHash, scanPublish, secretsIn } from '../src/publish.ts';
import { ownersOf, parseCodeowners, patternToRegExp, requiredReviewers } from '../src/codeowners.ts';
import { outOfScope, prBody, prTitle } from '../src/prbody.ts';

/** A repo with a base commit and a task branch; `commit` adds a commit on the branch. */
function repo() {
  const t = tempDir('publish');
  const { repo, sha: base } = makeRepo(t.dir, { 'README.md': 'hi\n', 'package.json': '{\n  "name": "x",\n  "dependencies": {}\n}\n', 'test/mock.ts': 'const k = "sk-or-' + 'v1-0000000000000000000000";\n' });
  gitIn(repo, 'checkout', '-q', '-b', 'task');
  const commit = (files: Record<string, string | null>, message = 'work') => {
    for (const [f, c] of Object.entries(files)) {
      const p = path.join(repo, f);
      if (c === null) fs.rmSync(p);
      else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
    }
    gitIn(repo, 'add', '-A');
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
    return gitIn(repo, 'rev-parse', 'HEAD');
  };
  return { t, repo, base, commit };
}
const scan = (r: ReturnType<typeof repo>, head: string, o: { pushed?: string | null; prText?: string; secrets?: string[] } = {}) =>
  scanPublish(r.repo, { head, base: r.base, pushed: o.pushed ?? null, prText: o.prText ?? 'T-1: a change', secrets: o.secrets ?? [] });

test('a clean change publishes; every commit in the range is scanned, not just the final tree', async () => {
  const r = repo();
  try {
    const a = r.commit({ 'src/a.ts': 'export const a = 1;\n' });
    assert.deepEqual((await scan(r, a)), { commits: [a], blocked: [], held: [] });
    // A key added in one commit and removed in the next is still in the push: blocked, naming the commit.
    const leak = r.commit({ 'src/b.ts': 'const key = "sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz";\n' });
    const fixed = r.commit({ 'src/b.ts': 'const key = process.env.KEY;\n' });
    const res = await scan(r, fixed);
    assert.deepEqual(res.blocked, [{ rule: 'secret:anthropic_key', commit: leak, path: 'src/b.ts' }]);
    // Already pushed commits aren't scanned again.
    assert.deepEqual((await scan(r, fixed, { pushed: leak })).blocked, []);
  } finally { r.t.cleanup(); }
});

test('denied paths, large files, held secrets, commit messages and the PR text block; dependency changes are held', async () => {
  const r = repo();
  try {
    const ci = r.commit({ '.github/workflows/x.yml': 'on: push\n' });
    const env = r.commit({ '.env': 'A=1\n', '.env.example': 'A=\n', 'logs/run.log': 'x\n', 'deploy/id_ed25519': 'x\n' });
    const big = r.commit({ 'blob.bin': 'x'.repeat(1024 * 1024 + 1) });
    const held = r.commit({ 'src/c.ts': 'const t = "the-local-token-value-123";\n' }, 'add c');
    const msg = r.commit({ 'src/d.ts': 'x\n' }, 'oops ghp_' + 'a'.repeat(36));
    const deps = r.commit({ 'package.json': '{\n  "name": "x",\n  "dependencies": { "left-pad": "1.0.0" }\n}\n', 'package-lock.json': '{}\n' });
    const res = await scan(r, deps, { secrets: ['the-local-token-value-123'], prText: 'body with github_pat_' + 'b'.repeat(30) });
    const rules = res.blocked.map((b) => `${b.rule}${b.path ? `:${b.path}` : ''}`).sort();
    assert.deepEqual(rules, [
      'ci_workflow:.github/workflows/x.yml', 'env_file:.env', 'key_file:deploy/id_ed25519', 'large_file:blob.bin', 'log_file:logs/run.log',
      'message:github_token', 'pr_text:github_pat', 'secret:held_secret:src/c.ts',
    ]);
    assert.ok(res.blocked.find((b) => b.rule === 'ci_workflow')!.commit === ci && res.blocked.find((b) => b.rule === 'env_file')!.commit === env);
    assert.ok(res.blocked.find((b) => b.rule === 'large_file')!.commit === big && res.blocked.find((b) => b.rule.startsWith('message'))!.commit === msg);
    assert.ok(res.blocked.find((b) => b.rule === 'secret:held_secret')!.commit === held);
    assert.deepEqual(res.held.map((h) => h.path).sort(), ['package-lock.json', 'package.json']);
    // An existing credential-shaped fixture isn't news: only added lines count.
    assert.ok(!res.blocked.some((b) => b.path === 'test/mock.ts'));
  } finally { r.t.cleanup(); }
});

test('a sync merge counts only for what differs from every parent: what came from the base is already public', async () => {
  const r = repo();
  try {
    const mine = r.commit({ 'src/mine.ts': 'x\n' });
    gitIn(r.repo, 'checkout', '-q', r.base);
    gitIn(r.repo, 'checkout', '-q', '-b', 'base2');
    fs.mkdirSync(path.join(r.repo, '.github'), { recursive: true });
    fs.writeFileSync(path.join(r.repo, '.github/ci.yml'), 'on: push\n'); // a human's workflow change on the base
    gitIn(r.repo, 'add', '-A');
    gitIn(r.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base moves');
    const base2 = gitIn(r.repo, 'rev-parse', 'HEAD');
    gitIn(r.repo, 'checkout', '-q', 'task');
    gitIn(r.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'sync', base2);
    const merged = gitIn(r.repo, 'rev-parse', 'HEAD');
    const res = await scanPublish(r.repo, { head: merged, base: base2, pushed: null, prText: 'x', secrets: [] });
    assert.deepEqual(res.blocked, [], 'the base\'s .github change came from the base, not the task');
    assert.ok(res.commits.includes(mine) && res.commits.includes(merged));
  } finally { r.t.cleanup(); }
});

test('the rules on their own', () => {
  assert.equal(deniedPath('.github/CODEOWNERS'), 'ci_workflow');
  assert.equal(deniedPath('a/.harness/x'), 'harness_state');
  assert.equal(deniedPath('.env.example'), null);
  assert.equal(deniedPath('.env.local'), 'env_file');
  assert.equal(deniedPath('src/key.ts'), null);
  assert.deepEqual(secretsIn('AKIAABCDEFGHIJKLMNOP and -----BEGIN OPENSSH PRIVATE KEY-----', []), ['aws_key', 'private_key']);
  assert.deepEqual(secretsIn('short', ['short']), [], 'held values under 8 characters are ignored');
  assert.notEqual(publishHash('a'.repeat(40), 'x'), publishHash('a'.repeat(40), 'y'));
});

test('CODEOWNERS: GitHub\'s last-match rule; the author never reviews their own change', () => {
  const rules = parseCodeowners([
    '# comment', '*  @DaniyalMughal1 @vihAan02', '/packages/daemon/  @DaniyalMughal1', '/packages/ui/  @vihAan02',
    '/docs/protocol.md  @DaniyalMughal1 @vihAan02', '*.md  @docs-team', '/packages/**/test/  @tester',
  ].join('\n'));
  const owners = ownersOf(rules, ['packages/daemon/src/a.ts', 'packages/ui/web/x.ts', 'README.md', 'docs/protocol.md', 'packages/cli/test/a.ts', 'tsconfig.json']);
  assert.deepEqual(Object.fromEntries(owners), {
    'packages/daemon/src/a.ts': ['DaniyalMughal1'], 'packages/ui/web/x.ts': ['vihAan02'], 'README.md': ['docs-team'],
    'docs/protocol.md': ['docs-team'], 'packages/cli/test/a.ts': ['tester'], 'tsconfig.json': ['DaniyalMughal1', 'vihAan02'],
  });
  assert.deepEqual(requiredReviewers(rules, ['packages/ui/web/x.ts'], 'DaniyalMughal1'), ['vihAan02']);
  assert.deepEqual(requiredReviewers(rules, ['packages/ui/web/x.ts'], 'vihAan02'), []);
  assert.deepEqual(requiredReviewers(rules, ['tsconfig.json'], 'vihAan02'), ['DaniyalMughal1']);
  assert.ok(patternToRegExp('/packages/ui/').test('packages/ui/a/b.ts') && !patternToRegExp('/packages/ui/').test('x/packages/ui/a'));
  assert.ok(patternToRegExp('*.md').test('a/b/c.md') && !patternToRegExp('*.md').test('a.mdx'));
});

test('the PR text fills every section of the template, and quotes the agent\'s words as the agent\'s', () => {
  const body = prBody({
    taskId: 'T-7', title: 'Board view', summary: 'Added the board.\nTests pass.', scope: ['packages/ui/'],
    agent: { id: 'agent_x', name: 'agent/ui' }, human: { id: 'human_vihaan', login: 'vihAan02' },
    changed: ['packages/ui/web/board.ts', 'packages/protocol/src/index.ts'], diffStat: ' 2 files changed', reviewers: ['DaniyalMughal1'],
    cost: { usd: 0.0421, sessions: 2, models: ['anthropic/claude-haiku-5.5'], provider: 'openrouter-haiku55' }, closes: 95,
  });
  for (const h of ['## What changed, and why', '## Files touched', '## Contract changes', '## D-IDs and F-IDs', '## Migrations', '## New config or environment variables', '## Tests run', '## Real-model cost', '## Review', '## Notes for the other stream', '## Follow-ups']) {
    assert.ok(body.includes(h), h);
  }
  assert.match(body, /Closes #95/);
  assert.match(body, /> Added the board\.\n> Tests pass\./);
  assert.match(body, /Outside the task's scope \(packages\/ui\/\):\*\*\n- `packages\/protocol\/src\/index\.ts`/);
  assert.match(body, /Touches contract files/);
  assert.match(body, /\$0\.0421 over 2 session\(s\), provider openrouter-haiku55/);
  assert.match(body, /\[x\] Needed from: @DaniyalMughal1/);
  assert.deepEqual(outOfScope([], ['a']), []);
  assert.equal(prTitle({ taskId: 'T-7', title: 'a\nb' }), 'T-7: a b');
});

test('content Git would hide from a diff is scanned anyway: a binary-looking file, and a -diff one; .gitattributes is held', async () => {
  const r = repo();
  try {
    const key = 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz';
    // A NUL byte makes Git call the file binary, and `-diff` tells it never to show one: both used to hide a key.
    const binary = r.commit({ 'assets/data.bin': `\0\0header\n${key}\n` });
    const hidden = r.commit({ '.gitattributes': 'notes.txt -diff\n', 'notes.txt': `token ${key}\n` });
    const res = await scan(r, hidden);
    assert.deepEqual(res.blocked.map((b) => [b.rule, b.commit, b.path]).sort((x, y) => String(x[2]).localeCompare(String(y[2]))), [
      ['secret:anthropic_key', binary, 'assets/data.bin'], ['secret:anthropic_key', hidden, 'notes.txt'],
    ]);
    assert.deepEqual(res.held.map((h) => [h.rule, h.path]), [['git_attributes_change', '.gitattributes']]);
  } finally { r.t.cleanup(); }
});
