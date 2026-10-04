// Read confinement must not break an agent's ordinary work (D-98; the A3 review's regression findings),
// nor open what sits next to a toolchain. A real pinned Claude Code session, the scripted model, and the
// policy harnessd computes, in a home that holds the harness's state, the checkout and the usual toolchains:
// nvm (reached through a symlinked `current`), pyenv shims, cargo's proxies into rustup, ~/.local/bin, the
// corepack cache, and a global Git config.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter, type ClaudeSession } from '../../packages/adapters/src/index.ts';
import { collect, script } from '../../packages/adapters/test/fixtures.ts';
import { DUMMY_KEY, startMock } from '../../packages/adapters/test/mock-api.ts';
import { readPolicyFor } from '../../packages/daemon/src/readpolicy.ts';

const H = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1w-home-')));
const CANARY = `T1W-CANARY-${randomUUID().slice(0, 8)}`;
const put = (rel: string, content: string, mode = 0o644) => {
  const p = path.join(H, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
  return p;
};
const tool = (rel: string, body: string) => put(rel, `#!/bin/sh\n${body}\n`, 0o755);
// Toolchains, each with something it needs beside its own bin.
tool('.nvm/versions/node/v99/bin/nvmtool', 'cat "$(dirname "$0")/../lib/nvm-lib.txt"');
put('.nvm/versions/node/v99/lib/nvm-lib.txt', 'NVM-OK\n');
fs.symlinkSync(path.join(H, '.nvm/versions/node/v99'), path.join(H, '.nvm/current'));
// fnm: PATH goes through a per-shell symlink in ~/.local/state, a folder that isn't opened, into its installation.
tool('.local/share/fnm/node-versions/v98/installation/bin/fnmtool', 'cat "$(dirname "$0")/../lib/fnm-lib.txt"');
put('.local/share/fnm/node-versions/v98/installation/lib/fnm-lib.txt', 'FNM-OK\n');
fs.mkdirSync(path.join(H, '.local/state/fnm_multishells'), { recursive: true });
fs.symlinkSync(path.join(H, '.local/share/fnm/node-versions/v98/installation'), path.join(H, '.local/state/fnm_multishells/4242_1'));
tool('.pyenv/versions/3.99/bin/pytool-real', 'echo PY-OK');
tool('.pyenv/shims/pytool', `exec "${path.join(H, '.pyenv/versions/3.99/bin/pytool-real')}"`);
tool('.rustup/toolchains/stable/bin/cargotool-real', 'echo RUST-OK');
tool('.cargo/bin/cargotool', `exec "${path.join(H, '.rustup/toolchains/stable/bin/cargotool-real')}"`);
tool('.local/bin/localtool', 'echo LOCAL-OK');
put('.cache/node/corepack/v1/pnpm/version.txt', 'COREPACK-OK\n');
// What sits next to them, and must stay closed.
put('.cargo/credentials.toml', `token = "${CANARY}"\n`);
put('.local/share/keyrings/login.keyring', `${CANARY}\n`);
put('.gitconfig', `# ${CANARY}\n[user]\n\tname = Someone\n`);
put('Documents/harness-canary.txt', `${CANARY}\n`);
// The harness's state and the checkout live in the home directory too, as they usually do.
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString().trim();
const repo = path.join(H, 'code', 'repo');
put('code/repo/src/app.ts', 'export const app = 1;\n');
git(path.join(H, 'code'), 'init', '-q', '-b', 'main', repo);
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'base');
const harnessRoot = path.join(H, '.harness');
const wt = path.join(harnessRoot, 'worktrees', 'prj', 'T-1');
fs.mkdirSync(path.dirname(wt), { recursive: true });
git(repo, 'worktree', 'add', '-q', '-b', 'harness/task/T-1', wt);

const realPath = process.env.PATH ?? '';
const realHome = process.env.HOME;
process.env.HOME = H; // the agent's shell gets harnessd's HOME and PATH (sessionEnv)
process.env.PATH = [path.join(H, '.nvm/current/bin'), path.join(H, '.local/state/fnm_multishells/4242_1/bin'), path.join(H, '.pyenv/shims'), path.join(H, '.cargo/bin'), path.join(H, '.local/bin'), realPath].join(':');
const mock = await startMock();
after(async () => {
  await mock.close();
  process.env.PATH = realPath;
  if (realHome) process.env.HOME = realHome;
  fs.rmSync(H, { recursive: true, force: true });
});

test('toolchains, the corepack cache and Git work under read confinement; credentials beside them stay closed', async () => {
  const policy = readPolicyFor({
    home: H, harnessRoot, repo, worktree: wt, gitCommonDir: path.join(repo, '.git'), readAllow: [], pathEnv: process.env.PATH!, tmpdir: os.tmpdir(), env: {},
  });
  const configDir = path.join(harnessRoot, 'vendor', 'agent_t1w', 'claude-config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const steps: [string, string, RegExp][] = [
    ['nvm via a symlinked current', 'nvmtool; echo EXIT=$?', /NVM-OK\s+EXIT=0/],
    ['fnm via its multishell symlink', 'fnmtool; echo EXIT=$?', /FNM-OK\s+EXIT=0/],
    ['a pyenv shim', 'pytool; echo EXIT=$?', /PY-OK\s+EXIT=0/],
    ['a cargo proxy into rustup', 'cargotool; echo EXIT=$?', /RUST-OK\s+EXIT=0/],
    ['~/.local/bin', 'localtool; echo EXIT=$?', /LOCAL-OK\s+EXIT=0/],
    ['the corepack cache', 'cat ~/.cache/node/corepack/v1/pnpm/version.txt; echo EXIT=$?', /COREPACK-OK\s+EXIT=0/],
    ['Git with a global config', 'git status --porcelain; git log --oneline -1; echo EXIT=$?', /base\s+EXIT=0/],
  ];
  const closed = ['cat ~/.cargo/credentials.toml', 'cat ~/.local/share/keyrings/login.keyring', 'cat ~/.gitconfig', 'cat ~/Documents/harness-canary.txt'];
  const adapter = new ClaudeAdapter();
  const h = await adapter.startSession({
    sessionId: randomUUID(), worktree: wt, gitCommonDir: path.join(repo, '.git'), configDir, ports: null, env: {}, secrets: {},
    auth: { mode: 'api-key', apiKey: DUMMY_KEY, baseUrl: mock.url }, instructions: 'X', tools: [], readPolicy: policy,
  }, { id: 'm1', origin: 'human', text: script(...[...steps.map((x) => x[1]), ...closed].map((c) => `Bash ${JSON.stringify({ command: c })}`), 'TEXT done') }) as ClaudeSession;
  const c = collect(adapter.observations(h));
  await c.turns(1, 120_000);
  await adapter.stopSession(h, 'kill');
  const last = mock.log.filter((e) => e.kind === 'main').at(-1)!;
  const results = (last.summary ?? []).flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool_result').map((b: any) => String(b.text)));
  assert.equal(results.length, steps.length + closed.length, results.join('\n---\n'));
  steps.forEach(([name, , ok], i) => assert.match(results[i]!, ok, `${name}: ${results[i]}`));
  closed.forEach((cmd, i) => assert.ok(!results[steps.length + i]!.includes(CANARY), `${cmd} leaked: ${results[steps.length + i]}`));
  assert.ok(!JSON.stringify(mock.log).includes(CANARY), 'the canary never reached the model');
});
