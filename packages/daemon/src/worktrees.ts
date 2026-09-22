import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, gitOk, resolveBaseRef } from "./git.ts";

export function slugify(s: string, fallback = "agent"): string {
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

/** `github.com/acme/app` → `github.com-acme-app`, used as a directory name. */
export function repoSlug(repoKey: string): string {
  return slugify(repoKey.replace(/^local:/, "local-"), "repo").slice(0, 80);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface CreatedWorktree {
  worktree: string;
  branch: string;
  baseRef: string;
}

/**
 * Creates `<worktreesDir>/<repo>/<agent>` on a fresh branch `mp/<member>/<agent>` started from the
 * latest base. Nothing is written inside the user's own checkout except git's worktree bookkeeping.
 */
export async function createAgentWorktree(opts: {
  repoRoot: string;
  repoKey: string;
  worktreesDir: string;
  memberSlug: string;
  agentSlug: string;
  baseBranch: string;
  fetch?: boolean;
}): Promise<CreatedWorktree> {
  const { repoRoot } = opts;
  if (opts.fetch !== false && (await gitOk(repoRoot, ["remote", "get-url", "origin"]))) {
    // Best effort: offline is fine, we'll start from whatever origin/<base> we already have.
    await git(repoRoot, ["fetch", "--quiet", "origin", opts.baseBranch], { allowFail: true });
  }
  const baseRef = await resolveBaseRef(repoRoot, opts.baseBranch);

  const parent = join(opts.worktreesDir, repoSlug(opts.repoKey));
  await mkdir(parent, { recursive: true });

  let suffix = 0;
  let branch: string;
  let worktree: string;
  for (;;) {
    const name = suffix ? `${opts.agentSlug}-${suffix + 1}` : opts.agentSlug;
    branch = `mp/${opts.memberSlug}/${name}`;
    worktree = join(parent, name);
    const taken =
      (await exists(worktree)) || (await gitOk(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]));
    if (!taken) break;
    if (++suffix > 50) throw new Error(`could not find a free worktree name for ${opts.agentSlug}`);
  }

  await git(repoRoot, ["worktree", "add", "--quiet", "-b", branch, worktree, baseRef]);
  return { worktree, branch, baseRef };
}

/** Removes the worktree directory. The branch is kept, since it may hold unlanded work. */
export async function removeAgentWorktree(opts: { repoRoot: string; worktree: string; force?: boolean }): Promise<void> {
  if (await exists(opts.worktree)) {
    await git(opts.repoRoot, ["worktree", "remove", ...(opts.force ? ["--force"] : []), opts.worktree]);
  }
  await git(opts.repoRoot, ["worktree", "prune"], { allowFail: true });
  await mkdir(dirname(opts.worktree), { recursive: true });
}
