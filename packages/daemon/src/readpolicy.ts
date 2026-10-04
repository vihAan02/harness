// What an agent session may read (0B item 7; D-61, D-98). harnessd computes the policy; the adapter
// enforces it three ways: static deny rules, a call-time check on the file tools, and the sandbox for
// shell reads. Denied: the home directory, the harness's own state and the main checkout. Allowed back:
// the task's worktree, the shared .git (read-only Git needs it), the toolchains on the agent's PATH, temp,
// and the paths the local config lists.
import path from 'node:path';
import fs from 'node:fs';
import { isInside, realish, type ReadPolicy } from '@harness/adapters';
import { CREDENTIAL_PATHS } from './setup.ts';

/** The human's own folders: never opened up by a toolchain guess or the config. */
const PERSONAL = ['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Public'];
/**
 * Toolchain managers whose whole directory holds only toolchains, so a `bin` or `shims` directory on PATH
 * inside one opens it (pyenv's shims run its libexec and versions, nvm's npm its lib). General folders such
 * as ~/.local or ~/.cargo are never opened whole: they hold credentials too (review findings).
 */
const MANAGER_ROOTS = ['.nvm', '.volta', '.pyenv', '.rbenv', '.nodenv', '.goenv', '.jenv', '.asdf', '.sdkman', '.bun', '.deno',
  '.local/share/mise', '.local/share/fnm', '.rustup'];
/** Environment variables naming a manager's directory, when it isn't the default. */
const MANAGER_ENV = ['NVM_DIR', 'VOLTA_HOME', 'PYENV_ROOT', 'RBENV_ROOT', 'NODENV_ROOT', 'ASDF_DATA_DIR', 'SDKMAN_DIR', 'BUN_INSTALL', 'DENO_INSTALL', 'RUSTUP_HOME'];

export type ReadPolicyInputs = {
  home: string; harnessRoot: string; repo: string; worktree: string; gitCommonDir: string;
  /** `[agents] read_allow` from the local config: absolute, or `~/` for the home directory. */
  readAllow: string[];
  /** The PATH the agent's shell gets. */
  pathEnv: string;
  tmpdir: string;
  /** harnessd's environment, for toolchain managers installed somewhere other than their default. */
  env?: Record<string, string | undefined>;
};

export function readPolicyFor(i: ReadPolicyInputs, log: (msg: string) => void = () => {}): ReadPolicy {
  const home = realish(i.home);
  const [harnessRoot, repo] = [realish(i.harnessRoot), realish(i.repo)];
  const env = i.env ?? {};
  const fromHome = (rel: string) => path.join(home, rel);
  // Both where a credential path is and where it really is: a symlinked ~/.ssh (a dotfiles repo) must not
  // be re-opened through its real location (review finding).
  const both = (ps: string[]) => [...new Set(ps.flatMap((p) => [p, realish(p)]))];
  const credentials = both(CREDENTIAL_PATHS.map(fromHome));
  // An allowed path never contains one of these (that would re-open them), nor sits inside a credential path,
  // the harness's state or the checkout (the policy adds the worktree and the shared .git itself).
  const guarded = [home, harnessRoot, repo, ...credentials, ...both(PERSONAL.map(fromHome))];
  const opened = (p: string) => guarded.find((g) => isInside(g, p)) ?? [...credentials, harnessRoot, repo].find((c) => isInside(p, c));
  const allow = [realish(i.worktree), realish(i.gitCommonDir)];
  const links = new Set<string>();
  const add = (p: string, why: string): boolean => {
    const opens = opened(p);
    if (opens) {
      log(`read confinement: not allowing ${p} (${why}): it would open ${opens}`);
      return false;
    }
    allow.push(p);
    return true;
  };
  const managers = both([...MANAGER_ROOTS.map(fromHome), ...MANAGER_ENV.map((k) => env[k]).filter((v): v is string => !!v && v.startsWith('/'))]);
  const depth = (p: string) => path.relative(home, p).split(path.sep).length;

  for (const dir of i.pathEnv.split(':')) {
    if (!dir.startsWith('/')) continue;
    const d = realish(dir);
    if (!isInside(d, home) || isInside(d, harnessRoot)) continue;
    if (!add(d, 'a directory on PATH')) continue;
    // A shell resolves a symlinked PATH entry (nvm's current, fnm's multishells) itself, so the sandbox
    // must allow the links on the way too.
    for (let p = path.resolve(dir); isInside(p, i.home) && p !== path.resolve(i.home); p = path.dirname(p)) {
      try { if (fs.lstatSync(p).isSymbolicLink() && !opened(p)) links.add(p); } catch { /* not there */ }
    }
    // The toolchain around it: the manager's own directory, or a versioned install root (…/node/v26/bin → v26).
    const manager = managers.find((m) => isInside(d, m));
    if (manager) add(manager, 'a toolchain manager on PATH');
    else if (['bin', 'shims'].includes(path.basename(d)) && depth(path.dirname(d)) >= 2) add(path.dirname(d), 'a toolchain on PATH');
    // cargo's binaries are rustup proxies, and builds read its registry; never ~/.cargo itself (credentials).
    if (d === fromHome('.cargo/bin')) {
      for (const p of [fromHome('.cargo/registry'), fromHome('.cargo/git'), env.RUSTUP_HOME ?? fromHome('.rustup')]) add(realish(p), 'Rust, with ~/.cargo/bin on PATH');
    }
  }
  // Package managers through corepack (pnpm, yarn) run from its cache of downloaded tarballs.
  const corepack = realish(env.COREPACK_HOME ?? fromHome('.cache/node/corepack'));
  if (isInside(corepack, home) && fs.existsSync(corepack)) add(corepack, 'the corepack cache');
  const tmp = realish(i.tmpdir);
  if (isInside(tmp, home)) add(tmp, 'the temp directory');
  for (const a of i.readAllow) add(realish(a.startsWith('~/') ? fromHome(a.slice(2)) : a), 'agents.read_allow');
  return {
    denyRoots: [...new Set([home, harnessRoot, repo])],
    allowRoots: [...new Set(allow)],
    ...(links.size ? { allowLinks: [...links].sort() } : {}),
  };
}
