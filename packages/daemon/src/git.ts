import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  readonly result: GitResult;
  readonly args: string[];
  constructor(args: string[], result: GitResult) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.args = args;
    this.result = result;
  }
}

/** Runs git without a shell. Never prompts for credentials. */
export function git(cwd: string, args: string[], opts: { allowFail?: boolean; maxBuffer?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        const result = { stdout: String(stdout), stderr: String(stderr), code };
        if (code !== 0 && !opts.allowFail) reject(new GitError(args, result));
        else resolve(result);
      },
    );
  });
}

export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return (await git(cwd, args, { allowFail: true })).code === 0;
}

/**
 * Normalizes a git remote URL to `host/owner/repo` so the same repo gets the same room no matter
 * how each teammate cloned it (ssh vs https, with or without `.git`).
 */
export function normalizeRemote(url: string): string {
  let u = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = /^([\w.-]+@)?([\w.-]+):(?!\/)(.+)$/.exec(u); // git@github.com:owner/repo
  if (scp && !/^[a-z]+:\/\//i.test(u)) return `${scp[2]!.toLowerCase()}/${scp[3]}`;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "file:") return `local:${decodeURIComponent(parsed.pathname)}`;
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    // A plain filesystem path, as used for local bare remotes.
    return `local:${u}`;
  }
}

export interface RepoInfo {
  root: string;
  remoteUrl: string | null;
  repoKey: string;
  defaultBase: string;
}

export async function repoInfo(path: string): Promise<RepoInfo> {
  const top = await git(path, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.code !== 0) throw new Error(`${path} is not inside a git repository`);
  // Always report the main checkout, even when called from inside a linked worktree.
  const common = (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const mainRoot = common.endsWith("/.git") ? common.slice(0, -"/.git".length) : top.stdout.trim();
  const root = await realpath(mainRoot);

  const remote = await git(root, ["remote", "get-url", "origin"], { allowFail: true });
  const remoteUrl = remote.code === 0 ? remote.stdout.trim() : null;
  const repoKey = remoteUrl ? normalizeRemote(remoteUrl) : `local:${root}`;
  return { root, remoteUrl, repoKey, defaultBase: await defaultBaseBranch(root) };
}

export async function defaultBaseBranch(root: string): Promise<string> {
  const head = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFail: true });
  if (head.code === 0 && head.stdout.trim().startsWith("origin/")) return head.stdout.trim().slice("origin/".length);
  for (const candidate of ["main", "master", "trunk", "develop"]) {
    if (await gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`])) return candidate;
    if (await gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) return candidate;
  }
  const current = await git(root, ["branch", "--show-current"], { allowFail: true });
  return current.stdout.trim() || "main";
}

/** `origin/<base>` when it exists locally, else `<base>`. */
export async function resolveBaseRef(root: string, base: string): Promise<string> {
  if (await gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`])) return `origin/${base}`;
  if (await gitOk(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`])) return base;
  throw new Error(`base branch "${base}" not found (tried origin/${base} and ${base})`);
}
