// Read capture on the harnessd side (0B item 1; D-88): hashing as Git does, confinement to the worktree,
// the best-effort shell parser, and batching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blobId, hashForRead, ignoredPaths, ReadTracker, type ReadReport } from '../src/reads.ts';
import { parseShellReads } from '../src/shellreads.ts';

function repo(format: 'sha1' | 'sha256' = 'sha1') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reads-')));
  const run = (...a: string[]) => execFileSync('git', a, { cwd: root, env: { PATH: process.env.PATH!, HOME: root, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  run('init', '-q', `--object-format=${format}`, '-b', 'main');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/types.ts'), 'export type User = { id: string };\n');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 255, 10, 13]));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.env\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  return { root, run };
}

test('hashes match `git hash-object` for text, empty and binary files, in SHA-1 and SHA-256 repos', async () => {
  for (const format of ['sha1', 'sha256'] as const) {
    const { root, run } = repo(format);
    for (const f of ['src/types.ts', 'empty.txt', 'bin.dat']) {
      assert.equal(hashForRead(root, f, format), run('hash-object', f), `${format} ${f}`);
      assert.equal(hashForRead(root, f, format), run('rev-parse', `HEAD:${f}`), 'the same id a land reads from the tree');
    }
    assert.equal(blobId(Buffer.from('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  }
});

test('only files the worktree owns are hashed: never .git, outside paths, or what a symlink points at outside', () => {
  const { root } = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-outside-'));
  fs.writeFileSync(path.join(outside, 'secret'), 'top secret\n');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'escape'));
  fs.symlinkSync('src/types.ts', path.join(root, 'alias.ts'));
  assert.equal(hashForRead(root, 'escape', 'sha1'), undefined, 'negative control for confinement: an escaping symlink is never read');
  assert.equal(hashForRead(root, 'alias.ts', 'sha1'), null, 'an inside symlink is recorded without a comparable hash');
  assert.equal(hashForRead(root, '.git/config', 'sha1'), undefined);
  assert.equal(hashForRead(root, '../x', 'sha1'), undefined);
  assert.equal(hashForRead(root, '/etc/passwd', 'sha1'), undefined);
  assert.equal(hashForRead(root, 'src', 'sha1'), undefined, 'a directory is not a read');
  assert.equal(hashForRead(root, 'missing.ts', 'sha1'), undefined);
});

test('ignored files are recognized in one batch', async () => {
  const { root } = repo();
  fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
  assert.deepEqual([...await ignoredPaths(root, ['node_modules/x/index.js', 'src/types.ts', '.env'])].sort(), ['.env', 'node_modules/x/index.js']);
  assert.deepEqual([...await ignoredPaths(root, ['src/types.ts'])], []);
});

test('the tracker batches, drops ignored files and repeats, and reports a stale path again after forget()', async () => {
  const { root } = repo();
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules/dep.js'), 'x');
  const sent: ReadReport[][] = [];
  const t = new ReadTracker({ worktree: root, send: async (e) => { sent.push(e); }, log: () => {}, debounceMs: 10_000 });
  await t.init();
  assert.equal(t.record([
    { path: 'src/types.ts', source: 'search_hit', confidence: 'medium' },
    { path: 'src/types.ts', source: 'read_tool', confidence: 'high', range: { start: 1, lines: 10 } },
    { path: 'node_modules/dep.js', source: 'read_tool', confidence: 'high' },
    { path: 'nope.ts', source: 'read_tool', confidence: 'high' },
  ]), 3);
  await t.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.map((e) => [e.path, e.source, e.confidence]), [['src/types.ts', 'read_tool', 'high']], 'ignored file dropped; the stronger capture kept');
  t.record([{ path: 'src/types.ts', source: 'read_tool', confidence: 'high' }]);
  await t.flush();
  assert.equal(sent.length, 1, 're-reading unchanged content sends nothing');
  t.forget(['src/types.ts']);
  t.record([{ path: 'src/types.ts', source: 'read_tool', confidence: 'high' }]);
  await t.flush();
  assert.equal(sent.length, 2, 'after a sync the re-read is reported, so the server can clear "stale"');
  fs.writeFileSync(path.join(root, 'src/types.ts'), 'changed\n');
  t.record([{ path: 'src/types.ts', source: 'shell_heuristic', confidence: 'low' }]);
  await t.flush();
  assert.equal(sent.length, 3, 'new content is always reported');
  assert.equal(t.counts.read_tool, 4);
});

test('shell reads: simple forms are parsed, everything else is counted as unparsed (D-88)', () => {
  const reads = (cmd: string) => parseShellReads(cmd).reads;
  assert.deepEqual(reads('cat src/types.ts'), [{ path: 'src/types.ts' }]);
  assert.deepEqual(reads('cat -n src/a.ts src/b.ts | grep foo'), [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
  assert.deepEqual(reads('head -n 20 src/a.ts'), [{ path: 'src/a.ts', range: { start: 1, lines: 20 } }]);
  assert.deepEqual(reads('head -5 src/a.ts && tail -f log.txt'), [{ path: 'src/a.ts', range: { start: 1, lines: 5 } }, { path: 'log.txt' }]);
  assert.deepEqual(reads("sed -n '10,20p' src/a.ts"), [{ path: 'src/a.ts', range: { start: 10, lines: 11 } }]);
  assert.deepEqual(reads('grep -n "User" src/types.ts src/api.ts'), [{ path: 'src/types.ts' }, { path: 'src/api.ts' }]);
  assert.deepEqual(reads('rg -e foo -C 2 src/types.ts'), [{ path: 'src/types.ts' }]);
  assert.deepEqual(reads('wc -l < src/a.ts'), [{ path: 'src/a.ts' }]);
  assert.deepEqual(reads('FOO=1 cat "src/with space.ts"'), [{ path: 'src/with space.ts' }]);
  assert.deepEqual(reads('npm test'), []);
  assert.deepEqual(parseShellReads('npm test').unparsed, 0, 'not read-like: not counted');
  // Given up on, and counted (coverage, H-03):
  for (const cmd of ['cat $FILE', 'cat src/*.ts', 'cat $(git ls-files)', 'cat ../other/x.ts', 'grep -r foo src', "sed -i 's/a/b/' src/a.ts", 'awk 1 src/a.ts', 'python3 read.py', 'cd src && cat a.ts', 'cat ~/x', '(cat a)']) {
    const r = parseShellReads(cmd);
    assert.ok(r.unparsed > 0, cmd);
    assert.ok(!r.reads.some((x) => /\$|\*|\.\.|~/.test(x.path)), cmd);
  }
  assert.deepEqual(reads('cd src && cat a.ts'), [], 'after cd, relative paths are ambiguous: not guessed');
});
