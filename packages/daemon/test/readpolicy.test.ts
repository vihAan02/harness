// harnessd's read policy for a session (0B item 7; D-98): deny home, harness state and the main
// checkout; allow the worktree, the shared .git, the toolchains on PATH, temp and configured paths, but
// never a path that would re-open credentials, the human's own folders, harness state or the checkout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realish } from '@harness/adapters';
import { readPolicyFor } from '../src/readpolicy.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-readpolicy-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const H = path.join(root, 'home');
const d = (p: string) => { const abs = path.join(H, p); fs.mkdirSync(abs, { recursive: true }); return abs; };
const harnessRoot = d('.harness');
const wt = d('.harness/worktrees/prj/T-1');
const repo = d('code/repo');
const gitDir = d('code/repo/.git');
for (const p of [
  '.nvm/versions/node/v24/bin', '.bun/bin', 'Library/pnpm', 'bin', '.local/bin', '.local/share/uv/credentials', '.cargo/bin', '.cargo/registry',
  '.pyenv/shims', '.pyenv/versions/3.13/bin', '.local/share/fnm/node-versions/v26/installation/bin', '.local/state/fnm_multishells',
  'tools/acme/bin', '.config/gh', 'dotfiles/ssh', 'dotfiles/bin', '.cache/node/corepack', 'tmp',
]) d(p);
fs.symlinkSync(path.join(H, '.local/share/fnm/node-versions/v26/installation'), path.join(H, '.local/state/fnm_multishells/42_1'));
fs.symlinkSync(path.join(H, '.nvm/versions/node/v24'), path.join(H, '.nvm/current'));
fs.symlinkSync(path.join(H, 'dotfiles/ssh'), path.join(H, '.ssh')); // a dotfiles repo, stow style
const rel = (ps: string[]) => ps.map((a) => (a.startsWith(H) ? path.relative(H, a) || '~' : a));
const base = { home: H, harnessRoot, repo, worktree: wt, gitCommonDir: gitDir, tmpdir: os.tmpdir(), readAllow: [] as string[] };

test('toolchains on PATH: the directory itself, a manager\'s own directory, a versioned install root; never ~/.local or ~/.cargo whole', () => {
  const logs: string[] = [];
  const pathEnv = [
    '/usr/bin', path.join(H, '.nvm/current/bin'), path.join(H, '.bun/bin'), path.join(H, 'Library/pnpm'), path.join(H, 'bin'),
    path.join(H, '.local/bin'), path.join(H, '.cargo/bin'), path.join(H, '.pyenv/shims'), path.join(H, '.local/state/fnm_multishells/42_1/bin'),
    path.join(H, 'tools/acme/bin'), path.join(H, '.config/gh'), H, 'relative/bin',
  ].join(':');
  const p = readPolicyFor({ ...base, pathEnv, env: { RUSTUP_HOME: path.join(H, 'rustup-elsewhere') } }, (m) => logs.push(m));
  assert.deepEqual(rel(p.denyRoots), ['~', '.harness', 'code/repo']);
  assert.deepEqual(rel(p.allowRoots), [
    '.harness/worktrees/prj/T-1', 'code/repo/.git',
    '.nvm/versions/node/v24/bin', '.nvm', // nvm's current resolves into its versions; nvm's own directory holds only toolchains
    '.bun/bin', '.bun',
    'Library/pnpm',
    'bin', // ~/bin: just itself
    '.local/bin', // never ~/.local: it holds keyrings, uv credentials, shell history
    '.cargo/bin', '.cargo/registry', '.cargo/git', 'rustup-elsewhere', // never ~/.cargo: credentials.toml
    '.pyenv/shims', '.pyenv', // pyenv's shims run its own scripts and versions
    '.local/share/fnm/node-versions/v26/installation/bin', '.local/share/fnm',
    'tools/acme/bin', 'tools/acme', // a versioned or vendored install root, two levels down
    '.cache/node/corepack', // pnpm and yarn through corepack
  ]);
  assert.deepEqual(rel(p.allowLinks ?? []), ['.local/state/fnm_multishells/42_1', '.nvm/current'], 'symlinks the shell walks through on PATH');
  assert.ok(logs.some((m) => m.includes(`not allowing ${path.join(H, '.config/gh')} `)), 'a PATH directory inside a credential directory is refused');
  assert.ok(logs.some((m) => m.includes(`not allowing ${H} `)), 'and one that is home itself');
});

test('a symlinked credential directory is guarded where it really is, so its real location is never opened', () => {
  const logs: string[] = [];
  const p = readPolicyFor({ ...base, pathEnv: path.join(H, 'dotfiles/bin'), readAllow: ['~/dotfiles'] }, (m) => logs.push(m));
  assert.ok(p.allowRoots.includes(path.join(H, 'dotfiles/bin')));
  assert.ok(!p.allowRoots.includes(path.join(H, 'dotfiles')), '~/dotfiles holds ~/.ssh\'s real files');
  assert.ok(logs.some((m) => m.includes('agents.read_allow') && m.includes(path.join(H, 'dotfiles/ssh'))));
});

test('read_allow never opens credentials, the human\'s folders, harness state or the checkout; temp in home is allowed', () => {
  const logs: string[] = [];
  const readAllow = ['~/.cache/ms-playwright', '/opt/tools', '~/.ssh', '~/.ssh/known_hosts', '~/Documents/notes', '~/Library',
    '~/.harness/worktrees', '~/.harness/secrets.toml', '~/code/repo/src', '/'];
  const p = readPolicyFor({ ...base, pathEnv: '', tmpdir: path.join(H, 'tmp'), readAllow }, (m) => logs.push(m));
  assert.deepEqual(rel(p.allowRoots), ['.harness/worktrees/prj/T-1', 'code/repo/.git', '.cache/node/corepack', 'tmp', '.cache/ms-playwright', '/opt/tools', 'Documents/notes']);
  for (const refused of ['.ssh', '.ssh/known_hosts', 'Library', '.harness/worktrees', '.harness/secrets.toml', 'code/repo/src']) {
    assert.ok(logs.some((m) => m.includes(`not allowing ${realish(path.join(H, refused))} `)), refused);
  }
  assert.ok(logs.some((m) => m.includes('not allowing / ')));
});

test('toolchains and temp outside home add nothing (the corepack cache is there whenever it exists); the policy is all real paths', () => {
  const p = readPolicyFor({ ...base, pathEnv: '/usr/bin:/opt/homebrew/bin' });
  assert.deepEqual(p.allowRoots, [wt, gitDir, path.join(H, '.cache/node/corepack')]);
  assert.equal(p.allowLinks, undefined);
  assert.ok([...p.denyRoots, ...p.allowRoots].every((x) => x === fs.realpathSync(x)));
});
