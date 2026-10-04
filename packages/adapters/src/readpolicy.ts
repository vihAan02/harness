// Read confinement (0B item 7; D-61, D-98): which paths an agent may read. Vendor-neutral: harnessd
// computes the policy, and each adapter enforces it through its vendor's channels.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads are denied inside `denyRoots` (the home directory, the harness's state, the main checkout),
 * except inside `allowRoots` (the task's worktree, the shared .git, toolchains). Anywhere else, such as
 * system paths or temp, stays readable. Both are real paths (no symlinks).
 * `allowLinks` are symlinks the shell must be able to pass through to reach an allowed root, such as a
 * PATH entry like ~/.nvm/current/bin (a shell resolves the link itself, so the sandbox has to allow the
 * link's own path). They only re-open the link, for shell commands; the file tools judge reads by where
 * they lead.
 */
export type ReadPolicy = { denyRoots: string[]; allowRoots: string[]; allowLinks?: string[] };

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

/**
 * How much static deny list a session carries: the rules reach the vendor's sandbox too, where each one
 * slows every shell command, and the whole list travels as one command-line argument (a crowded folder
 * once made it 1.3 MB: `spawn E2BIG`).
 */
export const DENIED_ENTRIES_BUDGET = 64 * 1024;

/**
 * Every entry inside the deny roots that isn't an allowed root or on the way to one: the static deny list
 * for a vendor whose deny rules beat its allow rules, so a root can't be denied with the worktree carved
 * back out (Claude Code, F-98). Entries created after this runs are caught at call time (`readAllowed`)
 * and, for shell reads, by the vendor's sandbox.
 * - Symlinks are skipped: the vendor resolves a rule to the link's target, which could be the agent's own
 *   worktree. The call-time check and the sandbox judge a link by where it leads.
 * - A directory on the way to an allowed root that can't be listed refuses the session (fail closed).
 * - Over the budget, the list is coarse: only each deny root's top level, the rest left to the call-time
 *   check and the sandbox, which already confine it.
 */
export function deniedEntries(policy: ReadPolicy, budget = DENIED_ENTRIES_BUDGET): { entries: string[]; coarse: boolean } {
  const onTheWay = (p: string) => policy.allowRoots.some((a) => a.startsWith(`${p}/`));
  const list = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
      throw new Error(`read confinement can't list ${dir} (${(e as NodeJS.ErrnoException).code}), on the way to an allowed path`);
    }
  };
  const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  const collect = (maxDepth: number): string[] => {
    const out = new Set<string>();
    const walk = (dir: string, depth: number) => {
      for (const n of list(dir)) {
        const p = path.join(dir, n);
        if (policy.allowRoots.includes(p) || isLink(p)) continue;
        if (onTheWay(p)) { if (depth < maxDepth) walk(p, depth + 1); }
        else out.add(p);
      }
    };
    for (const root of policy.denyRoots) {
      if (policy.allowRoots.some((a) => isInside(root, a))) continue; // all of it is allowed
      if (onTheWay(root)) walk(root, 1);
      else out.add(root);
    }
    return [...out].sort();
  };
  const size = (entries: string[]) => entries.reduce((n, e) => n + 2 * e.length + 16, 0);
  const full = collect(Infinity);
  if (size(full) <= budget) return { entries: full, coarse: false };
  const top = collect(1);
  return { entries: size(top) <= budget ? top : [], coarse: true };
}
