// Credentialed Git, host-side only (D-114, D-50). harnessd fetches the base and pushes task branches; agents never
// do, and never see a credential (D-64). Every call:
// - runs in the project's main repository, by ref: never in an agent's worktree, whose `.git` file the agent can
//   rewrite to point Git at another repository or config (TH-25);
// - talks to the configured remote URL, which carries no credentials (config.ts checks it): authentication comes from
//   the human's credential helper (`gh auth setup-git`), through HOME;
// - allows https only (`protocol.allow=never`, then `protocol.https.allow=always`), with hooks and fsmonitor off.
// Receivers never trust a commit someone names: they fetch the base branch themselves and check the commit is on it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'credential.interactive=never'];
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** How long one network Git call may take before it's an error (bounded, never a hang). */
const TIMEOUT_MS = 120_000;

export class RemoteError extends Error {}

function env(): Record<string, string> {
  // HOME for the credential helper and the user's Git config; nothing that could carry a token.
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
}

export async function gitRemote(repo: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', [...SAFE, ...args], { cwd: repo, env: env(), timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    return stdout.replace(/\n$/, '');
  } catch (e) {
    // Git's own message, minus anything that looks like a URL with credentials in it.
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message).replace(/https:\/\/[^@\s/]+@/g, 'https://***@').trim();
    throw new RemoteError(`git ${args[0]}: ${msg.split('\n').slice(-3).join(' ')}`);
  }
}

/** The ref harnessd keeps for the base as it last fetched it, per project. Never the human's own branches (D-114). */
export const fetchedRef = (projectId: string) => `refs/harness/${checkId(projectId)}/fetched`;
/** The ref the task worktrees' bases are measured against: only ever moved forward, by compare-and-swap. */
export const baseRef = (projectId: string) => `refs/harness/${checkId(projectId)}/base`;

function checkId(projectId: string): string {
  if (!ID.test(projectId)) throw new RemoteError(`malformed project id ${projectId}`);
  return projectId;
}

/**
 * One ref update at a time per repository. The poller, a land, a sync and a PR refresh all fetch the same ref, and
 * Git's ref lock fails a fetch whose ref moved while it ran ("cannot lock ref … is at X but expected Y").
 */
const queues = new Map<string, Promise<unknown>>();
function serially<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(repo) ?? Promise.resolve()).then(fn, fn);
  queues.set(repo, next.catch(() => {}));
  return next;
}

/** The base branch's tip on the remote, without fetching anything. */
export async function lsRemoteBase(repo: string, remote: string, branch: string): Promise<string> {
  if (!BRANCH.test(branch)) throw new RemoteError(`malformed branch ${branch}`);
  const out = await gitRemote(repo, 'ls-remote', '--', remote, `refs/heads/${branch}`);
  const sha = out.split('\t')[0] ?? '';
  if (!SHA.test(sha)) throw new RemoteError(`${remote} has no branch ${branch}`);
  return sha;
}

/**
 * Fetches the base branch into harnessd's own ref and returns its tip. No leading `+`: if the remote base ever moved
 * backwards (a force-push the ruleset forbids), the fetch fails loudly instead of following it.
 */
export async function fetchBase(repo: string, remote: string, branch: string, projectId: string): Promise<string> {
  if (!BRANCH.test(branch)) throw new RemoteError(`malformed branch ${branch}`);
  return serially(repo, async () => {
    await gitRemote(repo, 'fetch', '--no-tags', '--no-write-fetch-head', '--', remote, `refs/heads/${branch}:${fetchedRef(projectId)}`);
    return gitRemote(repo, 'rev-parse', '--verify', `${fetchedRef(projectId)}^{commit}`);
  });
}

/** Is `sha` on the fetched base (an ancestor of it, or it)? The check every receiver makes before trusting a commit. */
export async function onFetchedBase(repo: string, projectId: string, sha: string): Promise<boolean> {
  if (!SHA.test(sha)) return false;
  return gitRemote(repo, 'merge-base', '--is-ancestor', sha, fetchedRef(projectId)).then(() => true, () => false);
}

/**
 * Moves the base ref forward to `sha`, by compare-and-swap, and only forward: `sha` must contain the current base.
 * Returns whether it moved. The ref keeps every base a worktree started from or synced to reachable.
 */
export async function advanceBaseRef(repo: string, projectId: string, sha: string): Promise<boolean> {
  if (!SHA.test(sha)) throw new RemoteError(`not a commit id: ${sha}`);
  const ref = baseRef(projectId);
  return serially(repo, async () => {
    const current = await gitRemote(repo, 'rev-parse', '--verify', '--quiet', ref).catch(() => '');
    if (current === sha) return false;
    if (current && !(await gitRemote(repo, 'merge-base', '--is-ancestor', current, sha).then(() => true, () => false))) {
      throw new RemoteError(`${sha.slice(0, 12)} doesn't contain the current base ${current.slice(0, 12)}; the base never moves backwards`);
    }
    await gitRemote(repo, 'update-ref', ref, sha, current || '0'.repeat(40));
    return true;
  });
}

/**
 * Pushes `sha` to `refs/heads/<branch>` on the remote with an explicit lease: `expected` is what harnessd last pushed
 * there, or null for a first publish, which must find no such branch. Never forces past someone else's push.
 */
export async function pushBranch(repo: string, remote: string, sha: string, branch: string, expected: string | null): Promise<void> {
  if (!SHA.test(sha)) throw new RemoteError(`not a commit id: ${sha}`);
  if (!BRANCH.test(branch) || branch === 'main' || branch === 'master') throw new RemoteError(`refusing to push to ${branch}`);
  if (expected !== null && !SHA.test(expected)) throw new RemoteError(`not a commit id: ${expected}`);
  await gitRemote(repo, 'push', '--no-verify', `--force-with-lease=refs/heads/${branch}:${expected ?? ''}`, '--', remote, `${sha}:refs/heads/${branch}`);
}

/** The remote URL the human's clone uses for `name`, checked to carry no credentials (D-114). */
export async function checkRemoteUrl(repo: string, name = 'origin'): Promise<string> {
  const url = await gitRemote(repo, 'remote', 'get-url', '--', name);
  let u: URL;
  try { u = new URL(url); } catch { return url; } // scp-style ssh: no userinfo to leak
  if (u.username || u.password) throw new RemoteError(`${name}'s URL carries credentials; remove them (gh auth setup-git keeps them in the credential helper)`);
  return url;
}
