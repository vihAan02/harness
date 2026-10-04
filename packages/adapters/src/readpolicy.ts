// Read confinement (0B item 7; D-61, D-98): which paths an agent may read. Vendor-neutral: harnessd
// computes the policy, and each adapter enforces it through its vendor's channels.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads are denied inside `denyRoots` (the home directory, the harness's state, the main checkout),
 * except inside `allowRoots` (the task's worktree, the shared .git, toolchains). Anywhere else, such as
 * system paths or temp, stays readable. Every entry is a real path (no symlinks).
 */
export type ReadPolicy = { denyRoots: string[]; allowRoots: string[] };

export const isInside = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * The real path of `p`; if it doesn't exist yet, that of its nearest existing ancestor, plus the rest.
 * The native realpath, which also gives each existing component its on-disk case: on a case-insensitive
 * file system (macOS by default), `/USERS/me/documents` must not slip past a check on `/Users/me`.
 */
export function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** May the agent read `p` (relative to `cwd`)? Symlinks are followed, so a link inside the worktree can't point out. */
export function readAllowed(policy: ReadPolicy, p: string, cwd: string): boolean {
  const real = realish(path.resolve(cwd, p));
  if (policy.allowRoots.some((r) => isInside(real, r))) return true;
  return !policy.denyRoots.some((r) => isInside(real, r));
}

/** More entries than this to deny refuses the session: fail closed rather than confine partially. */
export const MAX_DENIED_ENTRIES = 5000;

/**
 * Every entry inside the deny roots that isn't an allowed root or on the way to one: the static deny list
 * for a vendor whose deny rules beat its allow rules, so a root can't be denied with the worktree carved
 * back out (Claude Code, F-98). Entries created after this runs are caught at call time (`readAllowed`)
 * and, for shell reads, by the vendor's sandbox.
 */
export function deniedEntries(policy: ReadPolicy, max = MAX_DENIED_ENTRIES): string[] {
  const out = new Set<string>();
  const onTheWay = (p: string) => policy.allowRoots.some((a) => a.startsWith(`${p}/`));
  const walk = (dir: string) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names.sort()) {
      const p = path.join(dir, n);
      if (policy.allowRoots.includes(p)) continue;
      if (onTheWay(p)) walk(p);
      else out.add(p);
      if (out.size > max) throw new Error(`read confinement would deny more than ${max} entries`);
    }
  };
  for (const root of policy.denyRoots) {
    if (policy.allowRoots.some((a) => isInside(root, a))) continue; // all of it is allowed
    if (onTheWay(root)) walk(root);
    else out.add(root);
  }
  return [...out].sort();
}
