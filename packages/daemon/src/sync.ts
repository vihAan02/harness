// Sync at turn end (0B item 2; D-53; coordination.md §2, "What the agent does with a notice"). When a peer's
// change lands, the reader's task branch is brought up to the new base before the reader is told, so the
// notice describes files the agent can now actually read:
//   1. (the caller holds the agent: no tool runs and no message lands while this runs)
//   2. commit the agent's work in progress on its task branch, as the agent (D-50);
//   3. merge the new base tip into the task branch, by commit id; the diff base advances with it, because
//      observed claims diff against the merge base;
//   4. on a conflict, abort: the worktree is left exactly as the agent had it, and the task is blocked
//      until the human resolves it (agents don't run Git writes, D-50).
// Delivering the held notice, with a diff excerpt, is the caller's next step.
import { commitAll, git } from './git.ts';
import { changedBetween, mergeCommit } from './integrate.ts';

export type SyncResult =
  | { ok: true; oldBase: string; newBase: string; wip: string | null; merge: string | null; changed: string[] }
  | { ok: false; oldBase: string; newBase: string; wip: string | null; conflicts: string[] };

/**
 * Brings the worktree's branch up to `target` (the base branch's tip). `oldBase` is the merge base before
 * the sync, `changed` the files the sync brought in. A branch that already contains `target` is a no-op.
 */
export async function syncWorktree(o: { worktree: string; target: string; taskId: string; agent: { name: string; email: string }; identity?: { name: string; email: string } }): Promise<SyncResult> {
  const oldBase = await git(o.worktree, 'merge-base', 'HEAD', o.target);
  // In a GitHub project, commits are the accountable human's (D-114): `identity` authors and commits them.
  const wip = await commitAll(o.worktree, `Work in progress before sync\n\nHarness-Task: ${o.taskId}\nHarness-Sync: ${o.target}`, o.identity ?? o.agent, o.identity);
  if (oldBase === o.target) return { ok: true, oldBase, newBase: o.target, wip, merge: null, changed: [] };
  const r = await mergeCommit(o.worktree, o.target, `Sync ${o.taskId} with the base at ${o.target.slice(0, 12)}\n\nHarness-Task: ${o.taskId}\nHarness-Sync: ${o.target}`, o.identity);
  if (!r.ok) return { ok: false, oldBase, newBase: o.target, wip, conflicts: r.conflicts };
  return { ok: true, oldBase, newBase: o.target, wip, merge: r.commit, changed: await changedBetween(o.worktree, oldBase, o.target) };
}

/** True once the worktree's branch contains `target`: the human resolved a conflict and merged it themselves. */
export async function contains(worktree: string, target: string): Promise<boolean> {
  try {
    await git(worktree, 'merge-base', '--is-ancestor', target, 'HEAD');
    return true;
  } catch {
    return false;
  }
}

/**
 * Paths the human left in conflict (unmerged index entries), else null. After `harness task unblock`, such a
 * state is never committed as the agent's work. A merge resolved but not committed is finished by the sync.
 */
export async function unresolved(worktree: string): Promise<string[] | null> {
  const unmerged = (await git(worktree, 'diff', '--name-only', '-z', '--diff-filter=U')).split('\0').filter(Boolean).sort();
  return unmerged.length ? unmerged : null;
}
