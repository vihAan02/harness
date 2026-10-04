// Git operations for the land step and for syncing a task branch (0B items 2 and 5; D-50, D-51, D-53).
// harnessd owns every Git write (D-50). Merges happen in worktrees, by commit id (never a branch name an
// agent could have moved), with hooks off (git.ts). The base branch only ever moves by a compare-and-swap
// or a fast-forward of a clean checkout, so a human's work is never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HARNESSD = ['-c', 'user.name=harnessd', '-c', 'user.email=harnessd@harness.invalid', '-c', 'commit.gpgsign=false'];

function requireSha(v: string, name: string): string {
  if (!SHA.test(v)) throw new Error(`${name} must be a full commit id, got ${v}`);
  return v;
}

export type MergeResult = { ok: true; commit: string } | { ok: false; conflicts: string[] };

/**
 * Merges `commit` into the worktree's HEAD with a merge commit (`--no-ff`), as harnessd. On a conflict the
 * merge is aborted, so the worktree is left exactly as it was, and the conflicting paths are returned.
 */
export async function mergeCommit(worktree: string, commit: string, message: string): Promise<MergeResult> {
  requireSha(commit, 'commit');
  try {
    await git(worktree, ...HARNESSD, 'merge', '--no-ff', '--no-edit', '-m', message, commit);
  } catch (e) {
    const conflicts = (await git(worktree, 'diff', '--name-only', '-z', '--diff-filter=U').catch(() => '')).split('\0').filter(Boolean).sort();
    await git(worktree, 'merge', '--abort').catch(() => {});
    if (!conflicts.length) throw e; // not a content conflict: a real error
    return { ok: false, conflicts };
  }
  return { ok: true, commit: await git(worktree, 'rev-parse', 'HEAD') };
}

/** Files that differ between two commits. */
export async function changedBetween(repo: string, from: string, to: string): Promise<string[]> {
  // --no-renames: a moved file names the path it left too, so the land's fencing check sees a file taken out of a
  // leased folder, and readers of the old path hear it changed (D-93). Rename detection is on by default.
  return (await git(repo, 'diff', '--no-renames', '--name-only', '-z', requireSha(from, 'from'), requireSha(to, 'to'))).split('\0').filter(Boolean).sort();
}

/** Each path's Git blob id at `commit`, or null where the path doesn't exist there (deleted). */
export async function blobsAt(repo: string, commit: string, paths: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(paths.map((p) => [p, null]));
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const listing = await git(repo, 'ls-tree', '-z', requireSha(commit, 'commit'), '--', ...chunk);
    for (const entry of listing.split('\0').filter(Boolean)) {
      const [meta, file] = [entry.slice(0, entry.indexOf('\t')), entry.slice(entry.indexOf('\t') + 1)];
      const [, type, id] = meta.split(' ');
      if (type === 'blob' && out.has(file)) out.set(file, id!);
    }
  }
  return out;
}

/**
 * Where each branch is checked out: `refs/heads/<name>` → worktree path. A worktree in the middle of a
 * rebase shows as detached, so the branch being rebased is read from its rebase state and counted too.
 */
export async function checkouts(repo: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const trees: string[] = [];
  let current = '';
  for (const line of (await git(repo, 'worktree', 'list', '--porcelain')).split('\n')) {
    if (line.startsWith('worktree ')) trees.push(current = line.slice('worktree '.length));
    else if (line.startsWith('branch ')) out.set(line.slice('branch '.length), current);
  }
  for (const wt of trees) {
    let gitDir: string;
    try { gitDir = await git(wt, 'rev-parse', '--absolute-git-dir'); } catch { continue; }
    for (const state of ['rebase-merge', 'rebase-apply']) {
      try {
        const head = fs.readFileSync(path.join(gitDir, state, 'head-name'), 'utf8').trim();
        if (head.startsWith('refs/heads/') && !out.has(head)) out.set(head, wt);
      } catch { /* no rebase in progress */ }
    }
  }
  return out;
}

export type AdvanceResult =
  | { ok: true; how: 'ref' | 'checkout'; checkout?: string }
  | { ok: false; reason: 'base_moved' | 'base_checkout_dirty' | 'base_checkout_conflict'; detail: string };

/**
 * Moves the base branch from `from` to `to`, which must contain it. If no worktree has the branch checked
 * out, a compare-and-swap of the ref (fails if anyone moved it meanwhile). If one does, usually the human's
 * own checkout, only a fast-forward of a clean checkout still at `from`, Git's own `updateInstead` rule: the
 * human's uncommitted work is never touched, and the base is left alone on any doubt.
 */
export async function advanceBase(repo: string, branch: string, from: string, to: string): Promise<AdvanceResult> {
  requireSha(from, 'from');
  requireSha(to, 'to');
  try {
    await git(repo, 'merge-base', '--is-ancestor', from, to);
  } catch {
    throw new Error(`${to} doesn't contain ${from}: refusing to move ${branch} backwards or sideways`);
  }
  const ref = `refs/heads/${branch}`;
  const at = (await checkouts(repo)).get(ref);
  if (!at) {
    try {
      await git(repo, 'update-ref', '-m', 'harness land', ref, to, from);
      return { ok: true, how: 'ref' };
    } catch (e) {
      return { ok: false, reason: 'base_moved', detail: `${branch} moved while the land ran: ${(e as Error).message.split('\n')[0]}` };
    }
  }
  const branchNow = await git(at, 'symbolic-ref', '-q', 'HEAD').catch(() => '');
  if (branchNow !== ref) return { ok: false, reason: 'base_checkout_conflict', detail: `${branch} is being rebased or otherwise worked on in ${at}; finish that, then land again` };
  const head = await git(at, 'rev-parse', 'HEAD');
  if (head !== from) return { ok: false, reason: 'base_moved', detail: `${branch} in ${at} is at ${head.slice(0, 12)}, not ${from.slice(0, 12)}` };
  if (await git(at, 'status', '--porcelain', '--untracked-files=no')) {
    return { ok: false, reason: 'base_checkout_dirty', detail: `${at} has uncommitted changes; commit or stash them, then land again` };
  }
  // By default Git's fast-forward overwrites ignored files (a local .env, say) that the incoming commit adds.
  // Checked here for a clear message; --no-overwrite-ignore backs it up.
  const added = (await git(at, 'diff', '--name-only', '-z', '--diff-filter=A', from, to)).split('\0').filter(Boolean);
  const inTheWay = added.filter((f) => { try { fs.lstatSync(path.join(at, f)); return true; } catch { return false; } });
  if (inTheWay.length) {
    return { ok: false, reason: 'base_checkout_conflict', detail: `the land adds files that already exist, untracked or ignored, in ${at}: ${inTheWay.slice(0, 10).join(', ')}; move them aside, then land again` };
  }
  try {
    await git(at, 'merge', '--ff-only', '--no-overwrite-ignore', '-q', to);
  } catch (e) {
    return { ok: false, reason: 'base_checkout_conflict', detail: `couldn't fast-forward ${at}: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}` };
  }
  const now = await git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
  if (now !== to) throw new Error(`${branch} is at ${now.slice(0, 12)} after the fast-forward, not ${to.slice(0, 12)}`);
  return { ok: true, how: 'checkout', checkout: at };
}

/** A detached integration worktree at `commit`, for merging and testing a land away from everyone's work. */
export async function addIntegrationWorktree(repo: string, dir: string, commit: string): Promise<void> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', '-q', '--detach', dir, requireSha(commit, 'commit'));
}

/** Removes only this worktree: no repository-wide prune, which would drop the human's worktrees on unmounted volumes. */
export async function removeIntegrationWorktree(repo: string, dir: string): Promise<void> {
  await git(repo, 'worktree', 'remove', '--force', dir).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Deletes a task branch only if the base now contains it, it still points where we think, and no worktree
 * has it checked out (`update-ref -d` alone would happily orphan one).
 */
export async function deleteMergedBranch(repo: string, branch: string, expected: string, base: string): Promise<boolean> {
  if ((await checkouts(repo)).has(`refs/heads/${branch}`)) return false;
  try {
    await git(repo, 'merge-base', '--is-ancestor', requireSha(expected, 'expected'), requireSha(base, 'base'));
    await git(repo, 'update-ref', '-d', `refs/heads/${branch}`, expected);
    return true;
  } catch {
    return false;
  }
}

/**
 * A short excerpt of how `file` changed between two commits, for a landed notice (D-53). Computed locally,
 * never sent through the protocol. Every line keeps its diff prefix (`+`, `-`, ` `, `@`), so no line of the
 * peer's content can begin like a harness envelope line.
 */
export async function diffExcerpt(repo: string, from: string, to: string, file: string, maxLines = 60, maxChars = 4000): Promise<string> {
  const raw = await git(repo, 'diff', '--no-color', '--no-ext-diff', '-U2', requireSha(from, 'from'), requireSha(to, 'to'), '--', file).catch(() => '');
  const body = raw.split('\n').filter((l) => /^[-+ @]/.test(l) && !l.startsWith('--- ') && !l.startsWith('+++ '));
  const out: string[] = [];
  let chars = 0;
  for (const line of body) {
    const l = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (out.length >= maxLines || chars + l.length > maxChars) { out.push(`… (${body.length - out.length} more diff lines)`); break; }
    out.push(l);
    chars += l.length + 1;
  }
  return out.join('\n');
}
