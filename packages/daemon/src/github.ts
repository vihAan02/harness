// The GitHub REST calls harnessd makes for a GitHub-mode project (D-114, D-115): find or open a task's PR, poll it,
// read the base branch's protections, and merge one approved head. Host-side only.
// - The token is the human's own `gh` login (S17), asked of `gh auth token` with a minimal environment when needed,
//   held in memory, never logged, never written, never given to an agent (D-48's spirit, D-64).
// - The API host is the config's `github_api`, which is pinned to https://api.github.com outside tests (config.ts).
// - Every call is bounded by a timeout. A timeout or a network error is the caller's to classify: for a merge it's
//   `outcome_unknown`, never a failure (D-115).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TIMEOUT_MS = 30_000;

export class GitHubError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** The human's `gh` token, asked for with no ambient GitHub variables, cached for a few minutes. */
export function ghToken(): () => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const { stdout } = await run('gh', ['auth', 'token', '--hostname', 'github.com'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', LC_ALL: 'C' },
      timeout: TIMEOUT_MS,
    });
    const token = stdout.trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error('`gh auth token` gave no usable token; run gh auth login');
    cached = { token, until: Date.now() + 5 * 60_000 };
    return token;
  };
}

export type PullRequest = {
  number: number; state: 'open' | 'closed'; merged: boolean; merge_commit_sha: string | null; mergeable: boolean | null; mergeable_state: string;
  title: string; body: string | null; html_url: string; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string; sha: string };
};
export type Review = { user: { login: string } | null; state: string; commit_id: string };
export type CheckRun = { name: string; status: string; conclusion: string | null };
export type Rule = { type: string; parameters?: Record<string, unknown> };

export class GitHubClient {
  api: string;
  repo: string; // owner/name
  token: () => Promise<string>;

  constructor(o: { api: string; repo: string; token: () => Promise<string> }) {
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(o.repo)) throw new Error(`malformed repo ${o.repo}`);
    this.api = o.api.replace(/\/+$/, '');
    this.repo = o.repo;
    this.token = o.token;
  }

  get owner(): string {
    return this.repo.split('/')[0]!;
  }

  /** One call. Resolves with the parsed body for 2xx; throws GitHubError for any other status. Network errors and timeouts throw as they are. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'harnessd', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text.slice(0, 500); }
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${(parsed as { message?: string } | null)?.message ?? ''}`.trim(), parsed);
    return parsed as T;
  }

  private r(path: string): string {
    return `/repos/${this.repo}${path}`;
  }

  /** The PRs, open or closed, whose head is this repo's `branch`. */
  pullsForBranch(branch: string): Promise<PullRequest[]> {
    return this.call('GET', this.r(`/pulls?state=all&head=${encodeURIComponent(`${this.owner}:${branch}`)}&per_page=10`));
  }

  createPull(p: { title: string; body: string; head: string; base: string }): Promise<PullRequest> {
    return this.call('POST', this.r('/pulls'), { ...p, maintainer_can_modify: false, draft: false });
  }

  pull(n: number): Promise<PullRequest> {
    return this.call('GET', this.r(`/pulls/${n}`));
  }

  reviews(n: number): Promise<Review[]> {
    return this.call('GET', this.r(`/pulls/${n}/reviews?per_page=100`));
  }

  async checkRuns(sha: string): Promise<CheckRun[]> {
    return (await this.call<{ check_runs: CheckRun[] }>('GET', this.r(`/commits/${sha}/check-runs?per_page=100`))).check_runs;
  }

  /** The rules that apply to a branch: rulesets and branch protection alike. */
  branchRules(branch: string): Promise<Rule[]> {
    return this.call('GET', this.r(`/rules/branches/${encodeURIComponent(branch)}`));
  }

  /**
   * Merges PR `n` only if its head is still `sha` (D-115): squash, with protections intact. GitHub answers 200 when
   * merged, 405 when it isn't mergeable (behind, checks, method), 409 when the head moved. The caller arms the land
   * before this, and treats anything else (a timeout, a 5xx) as outcome_unknown.
   */
  merge(n: number, sha: string, title: string, message: string): Promise<{ sha: string; merged: boolean; message: string }> {
    return this.call('PUT', this.r(`/pulls/${n}/merge`), { sha, merge_method: 'squash', commit_title: title, commit_message: message });
  }
}
