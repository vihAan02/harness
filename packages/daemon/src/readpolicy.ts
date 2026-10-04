// What an agent session may read (0B item 7; D-61, D-98). harnessd computes the policy; the adapter
// enforces it three ways: static deny rules, a call-time check on the file tools, and the sandbox for
// shell reads. Denied: the home directory, the harness's own state and the main checkout. Allowed back:
// the task's worktree, the shared .git (read-only Git needs it), toolchains installed in the home
// directory, temp, and the paths the local config lists.
import path from 'node:path';
import { isInside, realish, type ReadPolicy } from '@harness/adapters';
import { CREDENTIAL_PATHS } from './setup.ts';

/** The human's own folders: never opened up by a toolchain guess or the config. */
const PERSONAL = ['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', 'Public'];

export type ReadPolicyInputs = {
  home: string; harnessRoot: string; repo: string; worktree: string; gitCommonDir: string;
  /** `[agents] read_allow` from the local config: absolute, or `~/` for the home directory. */
  readAllow: string[];
  /** The PATH the agent's shell gets. */
  pathEnv: string;
  tmpdir: string;
};

export function readPolicyFor(i: ReadPolicyInputs, log: (msg: string) => void = () => {}): ReadPolicy {
  const home = realish(i.home);
  const [harnessRoot, repo] = [realish(i.harnessRoot), realish(i.repo)];
  const credentials = CREDENTIAL_PATHS.map((p) => path.join(home, p));
  // An allowed root may never contain one of these (allowing it would re-open them), nor sit inside a credential path.
  const guarded = [home, harnessRoot, repo, ...credentials, ...PERSONAL.map((p) => path.join(home, p))];
  const opened = (p: string) => guarded.find((g) => isInside(g, p)) ?? credentials.find((c) => isInside(p, c));
  const allow = [realish(i.worktree), realish(i.gitCommonDir)];
  const add = (p: string, why: string): void => {
    const opens = opened(p);
    if (opens) log(`read confinement: not allowing ${p} (${why}): it would open ${opens}`);
    else allow.push(p);
  };
  // Toolchains on the agent's PATH that live in the home directory (nvm, bun, pnpm, …): a bin
  // directory's install root (so `npm` finds its own modules), else the directory itself.
  for (const dir of i.pathEnv.split(':')) {
    if (!dir.startsWith('/')) continue;
    const d = realish(dir);
    if (!isInside(d, home) || isInside(d, harnessRoot)) continue;
    const root = path.basename(d) === 'bin' ? path.dirname(d) : d;
    const rootOpens = opened(root) !== undefined;
    add(rootOpens ? d : root, rootOpens ? 'a directory on PATH' : 'a toolchain on PATH');
  }
  const tmp = realish(i.tmpdir);
  if (isInside(tmp, home)) add(tmp, 'the temp directory');
  for (const a of i.readAllow) add(realish(a.startsWith('~/') ? path.join(home, a.slice(2)) : a), 'agents.read_allow');
  return { denyRoots: [...new Set([home, harnessRoot, repo])], allowRoots: [...new Set(allow)] };
}
