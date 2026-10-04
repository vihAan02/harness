// harnessd's read policy for a session (0B item 7; D-98): deny home, harness state and the main
// checkout; allow the worktree, the shared .git, toolchains on PATH, temp and configured paths, but
// never a path that would re-open credentials or the human's own folders.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPolicyFor } from '../src/readpolicy.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-readpolicy-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const H = path.join(root, 'home');
const d = (p: string) => { const abs = path.join(H, p); fs.mkdirSync(abs, { recursive: true }); return abs; };
const harnessRoot = d('.harness');
const wt = d('.harness/worktrees/prj/T-1');
const repo = d('code/repo');
const gitDir = d('code/repo/.git');
for (const p of ['.nvm/versions/node/v24/bin', '.bun/bin', 'Library/pnpm', 'bin', '.config/tool/bin', '.config/gh/bin', 'tmp']) d(p);
fs.symlinkSync(path.join(H, '.nvm/versions/node/v24/bin'), path.join(root, 'nvm-link')); // PATH entries are resolved

test('a session reads its worktree, the shared .git and its toolchains; home, harness state and the checkout are denied', () => {
  const logs: string[] = [];
  const pathEnv = ['/usr/bin', path.join(root, 'nvm-link'), path.join(H, '.bun/bin'), path.join(H, 'Library/pnpm'), path.join(H, 'bin'),
    path.join(H, '.config/tool/bin'), path.join(H, '.config/gh/bin'), H, 'relative/bin'].join(':');
  const p = readPolicyFor({
    home: H, harnessRoot, repo, worktree: wt, gitCommonDir: gitDir, pathEnv, tmpdir: path.join(H, 'tmp'),
    readAllow: ['~/.cache/ms-playwright', '/opt/tools', '~/.ssh', '~/.ssh/known_hosts', '~/Documents/notes'],
  }, (m) => logs.push(m));
  assert.deepEqual(p.denyRoots, [H, harnessRoot, repo]);
  const rel = p.allowRoots.map((a) => (a.startsWith(H) ? path.relative(H, a) || '~' : a));
  assert.deepEqual(rel, [
    '.harness/worktrees/prj/T-1', 'code/repo/.git',
    '.nvm/versions/node/v24', // a bin's install root, so npm finds its modules
    '.bun', 'Library/pnpm', // a PATH directory inside Library is fine; Library itself would not be
    'bin', // ~/bin's parent is home itself, so the directory alone
    '.config/tool', // its install root holds no credentials
    // ~/.config/gh/bin is inside a credential directory: refused outright
    'tmp',
    '.cache/ms-playwright', '/opt/tools', 'Documents/notes',
  ]);
  assert.ok(!p.allowRoots.includes(H), 'never the home directory itself');
  assert.ok(logs.some((m) => m.includes(path.join(H, '.ssh')) && m.includes('agents.read_allow')), 'a configured credential path is refused, and said so');
  assert.ok(logs.some((m) => m.includes(path.join(H, '.ssh/known_hosts'))), 'and so is a path inside one');
  assert.ok(logs.some((m) => m.includes(path.join(H, '.config/gh/bin'))), 'a PATH directory inside a credential directory too');
  assert.ok(!p.allowRoots.some((a) => a.startsWith(path.join(H, '.config/gh')) || a.startsWith(path.join(H, '.ssh'))));
  assert.ok(logs.some((m) => m.includes(`not allowing ${H} `)), 'a PATH entry that is home itself is refused');
});

test('temp outside home and toolchains outside home add nothing; the policy is all real paths', () => {
  const p = readPolicyFor({ home: H, harnessRoot, repo, worktree: wt, gitCommonDir: gitDir, pathEnv: '/usr/bin:/opt/homebrew/bin', tmpdir: os.tmpdir(), readAllow: [] });
  assert.deepEqual(p.allowRoots, [wt, gitDir]);
  assert.ok([...p.denyRoots, ...p.allowRoots].every((x) => x === fs.realpathSync(x)));
});
