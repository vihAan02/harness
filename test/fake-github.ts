// A deterministic stand-in for GitHub, for GitHub-mode integration tests (D-114, D-115; docs/protocol.md §11). Later
// cards (publish, PR polling, the reservation and merge, receive) test against it so no test needs real GitHub, a
// network or a token. It is two loopback servers over one bare repository:
// - **Git over smart HTTPS:** `git http-backend` as CGI behind a per-run self-signed certificate and HTTP Basic auth
//   (any username, the per-run token as the password). Clients trust the certificate through `http.sslCAInfo` and
//   authenticate through a credential helper, so no token is ever in a remote URL (D-64, D-114).
// - **The REST API over plain HTTP:** the handful of endpoints the harness uses, with GitHub's paths (no `/api`
//   prefix), its status codes and messages, and the same semantics as far as the harness relies on them: head.sha
//   follows pushes, `mergeable_state` (dirty, behind under strict, blocked by checks or reviews, clean, or unknown
//   while GitHub computes it), and the squash merge with its sha guard, compare-and-swap on the base and branch
//   deletion. Each semantic the harness depends on should also be pinned as an F-ID and checked on real GitHub.
// Test controls are plain methods (no HTTP): checks, reviews, a human's merge on GitHub, a commit straight on the base,
// eventual-consistency and fault toggles. Every request lands in `log`.
//
// The servers run in the test's own process: every Git call against `gitUrl` must be async (execFile, never
// execFileSync), or the event loop that serves it is blocked and the call hangs.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { tempDir } from '../packages/daemon/test/fixtures.ts';

export type Identity = { name: string; email: string };
/** A check run's outcome: a conclusion (status `completed`), or `queued` / `in_progress` (no conclusion yet). */
export type CheckValue = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required' | 'queued' | 'in_progress';
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
export type Rule = { type: string; parameters?: Record<string, unknown> };
/** The next merge call: answered, then the socket destroyed with no response (`drop`); 502 with nothing merged; or delayed. */
export type MergeFault = 'drop' | 'error5xx' | { delayMs: number };
export type LogEntry = { server: 'git' | 'api'; method: string; path: string; status: number }; // status 0: no response sent

/** The pilot repo's required status checks (CI's three jobs). */
export const REQUIRED_CHECKS = ['guard', 'unit-linux', 'full-macos'];
/** Conclusions a required check passes with on GitHub. */
const PASSING = new Set<CheckValue>(['success', 'neutral', 'skipped']);
const SHA = /^[0-9a-f]{40}$/;

type Pr = {
  number: number; title: string; body: string | null; head: string; base: string; author: string;
  state: 'open' | 'closed'; merged: boolean; mergeCommitSha: string | null;
  /** The head and base as of the last read, or frozen when the PR closed. */
  headSha: string; baseSha: string;
  createdAt: string; updatedAt: string; closedAt: string | null; mergedAt: string | null;
  /** `mergeableUnknownPolls`: the (head, base) pair last seen, and how many more reads report `unknown` for it. */
  unknown: { key: string; left: number };
  /** `staleReads`: the pre-merge object, and how many more reads return it. */
  stale: { json: Record<string, unknown>; left: number } | null;
};
type Review = { id: number; user: { login: string }; state: ReviewState; commit_id: string; submitted_at: string };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

export type FakeGitHubOptions = {
  owner?: string; repo?: string;
  /** The base branch's first commit. Default: a README. */
  files?: Record<string, string>;
  baseBranch?: string;
  /** Who the token belongs to: the author of every PR opened through the API, and by default of its squash commit. */
  user?: { login: string; name: string; email: string };
};

export class FakeGitHub {
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly user: { login: string; name: string; email: string };
  /** The per-run token: the Basic auth password for Git, the Bearer token for the API. */
  readonly token = randomBytes(20).toString('hex');
  /** The bare repository, `<root>/<owner>/<repo>.git`. */
  readonly gitDir: string;
  /** The self-signed certificate the HTTPS server presents; clients pin it with `http.sslCAInfo`. */
  readonly caFile: string;
  gitUrl = '';
  apiUrl = '';
  /** The web host (the Git server's origin), as in `html_url`. */
  webUrl = '';
  log: LogEntry[] = [];

  // ---------- toggles ----------
  /** The required-status-checks rule's strict policy: a head must contain the base tip to merge (`behind` otherwise). */
  strict = true;
  /** Each of these logins must have approved the current head (their latest review, stale ones not counted), or `blocked`. */
  requireReviewFrom: string[] | undefined = undefined;
  /** The next n reads of a PR after its head or base moves report `mergeable: null`, `mergeable_state: 'unknown'`. */
  mergeableUnknownPolls = 0;
  /** After a merge, the next n reads of that PR return its pre-merge (open, unmerged) object. */
  staleReads = 0;
  /** A fault for the next merge call only. */
  mergeFault: MergeFault | null = null;
  /** The squash commit's author and committer. Default: the PR's author. */
  mergeAuthor: Identity | null = null;
  mergeCommitter: Identity | null = null;

  private root: { dir: string; cleanup: () => void };
  private rulesOverride: Rule[] | null = null;
  private pulls = new Map<number, Pr>();
  private reviewsOf = new Map<number, Review[]>();
  private checks = new Map<string, Record<string, CheckValue>>([['*', Object.fromEntries(REQUIRED_CHECKS.map((c) => [c, 'success' as const]))]]);
  private nextNumber = 1;
  private nextReviewId = 1;
  private gitServer: https.Server | null = null;
  private apiServer: http.Server | null = null;
  private inflight = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(o: FakeGitHubOptions) {
    this.owner = o.owner ?? 'vihAan02';
    this.repo = o.repo ?? 'harness';
    this.baseBranch = o.baseBranch ?? 'main';
    this.user = o.user ?? { login: 'fake-user', name: 'Fake User', email: 'fake-user@users.noreply.github.com' };
    this.root = tempDir('fake-github');
    this.gitDir = path.join(this.root.dir, 'repos', this.owner, `${this.repo}.git`);
    this.caFile = path.join(this.root.dir, 'tls', 'cert.pem');
  }

  static async start(o: FakeGitHubOptions = {}): Promise<FakeGitHub> {
    const f = new FakeGitHub(o);
    try {
      await f.init(o.files ?? { 'README.md': `# ${f.repo}\n` });
    } catch (e) {
      await f.close();
      throw e;
    }
    return f;
  }

  private async init(files: Record<string, string>): Promise<void> {
    fs.mkdirSync(path.dirname(this.gitDir), { recursive: true });
    await this.git(['init', '-q', '--bare', '-b', this.baseBranch, this.gitDir], { cwd: this.root.dir });
    await this.git(['config', 'http.receivepack', 'true']); // pushes over HTTP; auth is the server's job here
    // A ruleset's pull_request rule makes GitHub refuse a direct push to the base (GH013). The hook reads the
    // protected refs from a file the fake rewrites whenever the rules change.
    fs.writeFileSync(path.join(this.gitDir, 'hooks', 'pre-receive'), [
      '#!/bin/sh',
      'while read old new ref; do',
      '  if grep -qxF "$ref" fake-protected-refs 2>/dev/null; then',
      '    echo "error: GH013: Repository rule violations found for $ref." >&2',
      '    echo "- Changes must be made through a pull request." >&2',
      '    exit 1',
      '  fi',
      'done',
      '',
    ].join('\n'), { mode: 0o755 });
    this.writeProtection();
    const first = await this.commitFiles(null, files, 'Initial commit', this.user);
    await this.git(['update-ref', `refs/heads/${this.baseBranch}`, first, '']);

    // A per-run certificate for 127.0.0.1, never reused, never trusted beyond the clients a test configures.
    const tls = path.dirname(this.caFile);
    fs.mkdirSync(tls, { recursive: true });
    const keyFile = path.join(tls, 'key.pem');
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyFile, '-out', this.caFile]);
    this.gitServer = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(this.caFile) }, (req, res) => this.track(this.serveGit(req, res).catch((e: Error) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`fake GitHub: ${e.message}\n`);
    })));
    this.apiServer = http.createServer((req, res) => this.track(this.serveApi(req, res)));
    const listen = (s: http.Server) => new Promise<number>((resolve, reject) => {
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
    });
    const gitPort = await listen(this.gitServer);
    this.webUrl = `https://127.0.0.1:${gitPort}`;
    this.gitUrl = `${this.webUrl}/${this.owner}/${this.repo}.git`;
    this.apiUrl = `http://127.0.0.1:${await listen(this.apiServer)}`;
  }

  async close(): Promise<void> {
    for (const s of [this.gitServer, this.apiServer]) {
      if (!s?.listening) continue;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    await Promise.allSettled([...this.inflight]); // a delayed merge still finishes before the repo goes
    this.root.cleanup();
  }

  // ---------- test controls ----------

  /** Check runs for `sha` (or `'*'`, every commit without its own), by name; replaces that commit's set. */
  setChecks(sha: string, checks: Record<string, CheckValue>): void {
    this.checks.set(sha, { ...checks });
  }

  addReview(n: number, r: { login: string; state: ReviewState; commit_id: string }): void {
    if (!this.pulls.has(n)) throw new Error(`no PR #${n}`);
    const list = this.reviewsOf.get(n) ?? [];
    list.push({ id: this.nextReviewId++, user: { login: r.login }, state: r.state, commit_id: r.commit_id, submitted_at: new Date().toISOString() });
    this.reviewsOf.set(n, list);
  }

  /** The base branch's rules (`GET rules/branches/{base}`). Setting them simulates missing or changed protections. */
  get rules(): Rule[] {
    return this.rulesOverride ?? [
      { type: 'pull_request', parameters: {
        allowed_merge_methods: ['squash'], dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: false,
        required_approving_review_count: this.requireReviewFrom?.length ? 1 : 0, required_review_thread_resolution: false,
      } },
      { type: 'required_status_checks', parameters: {
        do_not_enforce_on_create: false, strict_required_status_checks_policy: this.strict,
        required_status_checks: REQUIRED_CHECKS.map((context) => ({ context })),
      } },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
    ];
  }
  set rules(r: Rule[] | null) {
    this.rulesOverride = r === null ? null : structuredClone(r);
    this.writeProtection();
  }

  /** Merges PR n as a human on GitHub would: past checks, reviews and strictness, but not past a conflict. Returns the squash commit. */
  externalMerge(n: number, o: { title?: string; message?: string } = {}): Promise<string> {
    return this.serial(async () => {
      const pr = this.pull(n);
      if (pr.state !== 'open') throw new Error(`PR #${n} is ${pr.merged ? 'merged' : 'closed'}`);
      const head = await this.headOf(pr);
      const base = await this.must(pr.base);
      if ((await this.mergeTree(base, head)) === null) throw new Error(`PR #${n} conflicts with ${pr.base}`);
      return this.squash(pr, base, head, o.title, o.message);
    });
  }

  /** A commit straight on the base branch (a change merged outside the harness). `null` deletes a file. Returns the new tip. */
  pushToBase(files: Record<string, string | null>, message: string): Promise<string> {
    return this.serial(async () => {
      const old = await this.must(this.baseBranch);
      const sha = await this.commitFiles(old, files, message, this.user);
      await this.git(['update-ref', `refs/heads/${this.baseBranch}`, sha, old]);
      return sha;
    });
  }

  /** Closes PR n unmerged, as a human might. Its head and base stay where they were at closing. */
  closePr(n: number): Promise<void> {
    return this.serial(async () => {
      const pr = this.pull(n);
      if (pr.state === 'closed') return;
      await this.refresh(pr);
      pr.state = 'closed';
      pr.closedAt = pr.updatedAt = new Date().toISOString();
    });
  }

  /** Every PR as recorded (no Git reads, no toggles consumed). */
  prs(): { number: number; title: string; body: string | null; head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeCommitSha: string | null }[] {
    return [...this.pulls.values()].map((p) => ({ number: p.number, title: p.title, body: p.body, head: p.head, base: p.base, state: p.state, merged: p.merged, mergeCommitSha: p.mergeCommitSha }));
  }

  baseTip(): Promise<string> {
    return this.must(this.baseBranch);
  }

  /** A branch's tip in the fake's repository, or null if there's no such branch. */
  async tip(branch: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { codes: [0, 1] });
    return r.code === 0 ? r.out : null;
  }

  /** Runs Git in the fake's bare repository (to inspect trees, parents, messages). */
  async git(args: string[], o: { cwd?: string; env?: Record<string, string>; input?: string } = {}): Promise<string> {
    return (await this.run(args, { ...o, codes: [0] })).out;
  }

  // ---------- Git over HTTPS ----------

  private async serveGit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://x');
    const entry: LogEntry = { server: 'git', method: req.method ?? '', path: url.pathname + url.search, status: 0 };
    this.log.push(entry);
    const user = this.basicUser(req.headers.authorization);
    if (user === null) {
      entry.status = 401;
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake"', 'Content-Type': 'text/plain' }).end('Unauthorized\n');
      return;
    }
    if (!url.pathname.startsWith(`/${this.owner}/${this.repo}.git/`)) {
      entry.status = 404;
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found\n');
      return;
    }
    // The CGI environment (RFC 3875) http-backend reads. HOME and no system config: the user's Git config never applies.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.root.dir, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C',
      GIT_PROJECT_ROOT: path.join(this.root.dir, 'repos'), GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method ?? 'GET',
      REMOTE_USER: user, REMOTE_ADDR: req.socket.remoteAddress ?? '127.0.0.1', GATEWAY_INTERFACE: 'CGI/1.1', SERVER_PROTOCOL: 'HTTP/1.1',
    };
    const header = (name: string, cgi: string) => { const v = req.headers[name]; if (typeof v === 'string') env[cgi] = v; };
    header('content-type', 'CONTENT_TYPE');
    header('content-length', 'CONTENT_LENGTH'); // absent with chunked uploads: http-backend then reads to EOF
    header('content-encoding', 'HTTP_CONTENT_ENCODING');
    header('git-protocol', 'HTTP_GIT_PROTOCOL');
    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {}); // http-backend may answer (an error) before reading the whole body
    req.pipe(child.stdin);
    const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
    const raw = Buffer.concat(out);
    let end = raw.indexOf('\r\n\r\n');
    let sep = 4;
    if (end < 0) { end = raw.indexOf('\n\n'); sep = 2; }
    if (end < 0) {
      entry.status = 502;
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`http-backend exited ${code} with no CGI headers\n`);
      return;
    }
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of raw.subarray(0, end).toString('latin1').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    entry.status = status;
    res.writeHead(status, headers).end(raw.subarray(end + sep));
  }

  /** The username from HTTP Basic auth whose password is the token; null otherwise. */
  private basicUser(h: string | undefined): string | null {
    const m = /^Basic\s+(\S+)$/i.exec(h ?? '');
    if (!m) return null;
    const text = Buffer.from(m[1]!, 'base64').toString('utf8');
    const i = text.indexOf(':');
    return i >= 0 && text.slice(i + 1) === this.token ? text.slice(0, i) || 'x' : null;
  }

  // ---------- the REST API ----------

  private async serveApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const entry: LogEntry = { server: 'api', method: req.method ?? '', path: url.pathname + url.search, status: 0 };
    this.log.push(entry);
    let reply: Reply | null;
    try {
      reply = await this.routeApi(req, res, url);
    } catch (e) {
      reply = { status: 500, body: { message: `fake GitHub: ${(e as Error).message}` } };
    }
    if (!reply || res.destroyed) return; // dropped on purpose (mergeFault)
    entry.status = reply.status;
    res.writeHead(reply.status, { 'Content-Type': 'application/json; charset=utf-8', ...reply.headers }).end(JSON.stringify(reply.body));
  }

  /** The reply to one API request, or null when the connection was dropped without one. */
  private async routeApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<Reply | null> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const auth = /^(?:Bearer|token)\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!auth || auth[1] !== this.token) return { status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' } };
    let body: Record<string, unknown> = {};
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { return { status: 400, body: { message: 'Problems parsing JSON' } }; }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return { status: 400, body: { message: 'Problems parsing JSON' } };
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    // Owner and repo names are case-insensitive on GitHub.
    if (!m || m[1]!.toLowerCase() !== this.owner.toLowerCase() || m[2]!.toLowerCase() !== this.repo.toLowerCase()) return NOT_FOUND;
    const rest = m[3]!;
    const method = req.method ?? 'GET';
    let r: RegExpExecArray | null;

    if (rest === 'pulls' && method === 'POST') return await this.serial(() => this.createPull(body));
    if (rest === 'pulls' && method === 'GET') return await this.listPulls(url.searchParams);
    if ((r = /^pulls\/(\d+)$/.exec(rest)) && method === 'GET') return await this.getPull(Number(r[1]));
    if ((r = /^pulls\/(\d+)\/reviews$/.exec(rest)) && method === 'GET') {
      if (!this.pulls.has(Number(r[1]))) return NOT_FOUND;
      return { status: 200, body: this.reviewsOf.get(Number(r[1])) ?? [] };
    }
    if ((r = /^pulls\/(\d+)\/merge$/.exec(rest)) && method === 'PUT') {
      const fault = this.mergeFault;
      this.mergeFault = null;
      if (fault === 'error5xx') return { status: 502, body: { message: 'Server Error' } };
      if (fault && typeof fault === 'object') await sleep(fault.delayMs);
      const reply = await this.serial(() => this.mergePull(Number(r![1]), body));
      if (fault === 'drop') { res.socket?.destroy(); return null; } // done on GitHub's side; the caller never hears (outcome unknown)
      return reply;
    }
    if ((r = /^commits\/([^/]+)\/check-runs$/.exec(rest)) && method === 'GET') {
      const sha = await this.resolve(decodeURIComponent(r[1]!));
      if (!sha) return { status: 422, body: { message: `No commit found for SHA: ${r[1]}` } };
      const runs = Object.entries(this.checks.get(sha) ?? this.checks.get('*') ?? {}).map(([name, v], i) => {
        const done = v !== 'queued' && v !== 'in_progress';
        return { id: i + 1, name, head_sha: sha, status: done ? 'completed' : v, conclusion: done ? v : null };
      });
      return { status: 200, body: { total_count: runs.length, check_runs: runs } };
    }
    if ((r = /^rules\/branches\/(.+)$/.exec(rest)) && method === 'GET') {
      const branch = decodeURIComponent(r[1]!);
      const source = { ruleset_source_type: 'Repository', ruleset_source: `${this.owner}/${this.repo}`, ruleset_id: 1 };
      return { status: 200, body: branch === this.baseBranch ? this.rules.map((x) => ({ ...x, ...source })) : [] };
    }
    if ((r = /^branches\/(.+)$/.exec(rest)) && method === 'GET') {
      const name = decodeURIComponent(r[1]!);
      const sha = await this.tip(name);
      if (!sha) return { status: 404, body: { message: 'Branch not found' } };
      return { status: 200, body: { name, commit: { sha }, protected: name === this.baseBranch } };
    }
    return NOT_FOUND;
  }

  private async createPull(b: Record<string, unknown>): Promise<Reply> {
    const invalid = (field: string): Reply => ({ status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field, code: 'invalid' }] } });
    const custom = (message: string): Reply => ({ status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message }] } });
    if (typeof b.title !== 'string' || !b.title) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }] } };
    if (typeof b.head !== 'string' || typeof b.base !== 'string') return invalid(typeof b.head !== 'string' ? 'head' : 'base');
    // `owner:branch` or `branch`; a fork's head is out of scope.
    const i = b.head.indexOf(':');
    if (i >= 0 && b.head.slice(0, i).toLowerCase() !== this.owner.toLowerCase()) return invalid('head');
    const head = i >= 0 ? b.head.slice(i + 1) : b.head;
    const headSha = await this.tip(head);
    if (!headSha) return invalid('head');
    const baseSha = await this.tip(b.base);
    if (!baseSha) return invalid('base');
    if ([...this.pulls.values()].some((p) => p.state === 'open' && p.head === head && p.base === b.base)) return custom(`A pull request already exists for ${this.owner}:${head}.`);
    if (await this.isAncestor(headSha, baseSha)) return custom(`No commits between ${b.base} and ${head}`);
    const now = new Date().toISOString();
    const pr: Pr = {
      number: this.nextNumber++, title: b.title, body: typeof b.body === 'string' ? b.body : null, head, base: b.base, author: this.user.login,
      state: 'open', merged: false, mergeCommitSha: null, headSha, baseSha, createdAt: now, updatedAt: now, closedAt: null, mergedAt: null,
      unknown: { key: '', left: 0 }, stale: null,
    };
    this.pulls.set(pr.number, pr);
    // As on GitHub, mergeability isn't computed yet when the PR is created.
    return { status: 201, body: { ...this.json(pr), merged: false, mergeable: null, mergeable_state: 'unknown' } };
  }

  private async listPulls(q: URLSearchParams): Promise<Reply> {
    const state = q.get('state') ?? 'open';
    let headFilter = q.get('head');
    if (headFilter?.includes(':')) {
      const [owner, branch] = [headFilter.slice(0, headFilter.indexOf(':')), headFilter.slice(headFilter.indexOf(':') + 1)];
      if (owner.toLowerCase() !== this.owner.toLowerCase()) return { status: 200, body: [] };
      headFilter = branch;
    }
    const base = q.get('base');
    const out: Record<string, unknown>[] = [];
    for (const pr of [...this.pulls.values()].sort((x, y) => y.number - x.number)) {
      if (state !== 'all' && pr.state !== state) continue;
      if (headFilter && pr.head !== headFilter) continue;
      if (base && pr.base !== base) continue;
      await this.refresh(pr);
      out.push(this.json(pr)); // as on GitHub, the list has no merged, mergeable or mergeable_state
    }
    return { status: 200, body: out };
  }

  private async getPull(n: number): Promise<Reply> {
    const pr = this.pulls.get(n);
    if (!pr) return NOT_FOUND;
    if (pr.stale && pr.stale.left > 0) {
      pr.stale.left--;
      return { status: 200, body: pr.stale.json };
    }
    const json = await this.fullJson(pr);
    if (pr.state === 'open') {
      // GitHub computes mergeability in the background after a push to the head or a move of the base.
      const key = `${pr.headSha} ${pr.baseSha}`;
      if (pr.unknown.key !== key) pr.unknown = { key, left: this.mergeableUnknownPolls };
      if (pr.unknown.left > 0) {
        pr.unknown.left--;
        return { status: 200, body: { ...json, mergeable: null, mergeable_state: 'unknown' } };
      }
    }
    return { status: 200, body: json };
  }

  private async mergePull(n: number, b: Record<string, unknown>): Promise<Reply> {
    const pr = this.pulls.get(n);
    if (!pr) return NOT_FOUND;
    if (pr.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    const method = b.merge_method ?? 'merge';
    if (method !== 'squash') {
      const message = method === 'merge' ? 'Merge commits are not allowed on this repository.' : method === 'rebase' ? 'Rebase merges are not allowed on this repository.' : `Merge method ${String(method)} is not allowed.`;
      return { status: 405, body: { message } };
    }
    await this.refresh(pr);
    if (b.sha !== undefined && b.sha !== pr.headSha) return { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } };
    if ((await this.mergeability(pr)).mergeable_state !== 'clean') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    const title = typeof b.commit_title === 'string' ? b.commit_title : undefined;
    const message = typeof b.commit_message === 'string' ? b.commit_message : undefined;
    try {
      const sha = await this.squash(pr, pr.baseSha, pr.headSha, title, message);
      return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
    } catch (e) {
      if (e instanceof BaseMoved) return { status: 405, body: { message: 'Base branch was modified. Review and try the merge again.' } };
      throw e;
    }
  }

  /**
   * The squash merge, as GitHub builds it: the tree of merging head into the base tip, one parent (the base tip),
   * `title\n\nmessage`; then a compare-and-swap of the base ref, the PR closed as merged, and the head branch
   * deleted (delete_branch_on_merge). When head contains the base, the tree is head's tree.
   */
  private async squash(pr: Pr, base: string, head: string, title?: string, message?: string): Promise<string> {
    const tree = await this.mergeTree(base, head);
    if (tree === null) throw new Error(`PR #${pr.number} conflicts with ${pr.base}`);
    const before = this.staleReads > 0 ? await this.fullJson(pr) : null;
    const author = this.mergeAuthor ?? this.authorOf(pr);
    const committer = this.mergeCommitter ?? author;
    const subject = title ?? `${pr.title} (#${pr.number})`;
    const sha = await this.git(['commit-tree', tree, '-p', base, '-F', '-'], { env: identityEnv(author, committer), input: message ? `${subject}\n\n${message}\n` : `${subject}\n` });
    if ((await this.run(['update-ref', `refs/heads/${pr.base}`, sha, base], { codes: [0, 128] })).code !== 0) throw new BaseMoved();
    const now = new Date().toISOString();
    Object.assign(pr, { state: 'closed', merged: true, mergeCommitSha: sha, headSha: head, baseSha: base, closedAt: now, mergedAt: now, updatedAt: now });
    if (before) pr.stale = { json: before, left: this.staleReads };
    await this.run(['update-ref', '-d', `refs/heads/${pr.head}`, head], { codes: [0, 128] }); // a push in between keeps the branch
    return sha;
  }

  // ---------- PR state ----------

  /** An open PR's head and base follow the branches; a closed one's stay where they were. */
  private async refresh(pr: Pr): Promise<void> {
    if (pr.state !== 'open') return;
    pr.headSha = (await this.tip(pr.head)) ?? pr.headSha;
    pr.baseSha = (await this.tip(pr.base)) ?? pr.baseSha;
  }

  private async mergeability(pr: Pr): Promise<{ mergeable: boolean | null; mergeable_state: string }> {
    if (pr.state !== 'open') return { mergeable: null, mergeable_state: 'unknown' };
    if ((await this.mergeTree(pr.baseSha, pr.headSha)) === null) return { mergeable: false, mergeable_state: 'dirty' };
    const checksRule = pr.base === this.baseBranch ? this.rules.find((r) => r.type === 'required_status_checks') : undefined;
    const strict = checksRule?.parameters?.strict_required_status_checks_policy === true;
    if (strict && !(await this.isAncestor(pr.baseSha, pr.headSha))) return { mergeable: true, mergeable_state: 'behind' };
    const required = ((checksRule?.parameters?.required_status_checks ?? []) as { context: string }[]).map((c) => c.context);
    const runs = this.checks.get(pr.headSha) ?? this.checks.get('*') ?? {};
    const checksOk = required.every((c) => runs[c] !== undefined && PASSING.has(runs[c]));
    if (!checksOk || !this.reviewed(pr)) return { mergeable: true, mergeable_state: 'blocked' };
    return { mergeable: true, mergeable_state: 'clean' };
  }

  /** Each required reviewer's latest decisive review approves the current head (stale approvals are dismissed on push). */
  private reviewed(pr: Pr): boolean {
    const reviews = this.reviewsOf.get(pr.number) ?? [];
    return (this.requireReviewFrom ?? []).every((login) => {
      const last = reviews.filter((r) => r.user.login === login && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED')).at(-1);
      return last?.state === 'APPROVED' && last.commit_id === pr.headSha;
    });
  }

  /** The PR object as the list endpoint returns it. */
  private json(pr: Pr): Record<string, unknown> {
    const ref = (name: string, sha: string) => ({ label: `${this.owner}:${name}`, ref: name, sha, repo: { full_name: `${this.owner}/${this.repo}` } });
    return {
      url: `${this.apiUrl}/repos/${this.owner}/${this.repo}/pulls/${pr.number}`, id: pr.number, number: pr.number, state: pr.state, locked: false,
      title: pr.title, body: pr.body, draft: false, user: { login: pr.author },
      html_url: `${this.webUrl}/${this.owner}/${this.repo}/pull/${pr.number}`,
      created_at: pr.createdAt, updated_at: pr.updatedAt, closed_at: pr.closedAt, merged_at: pr.mergedAt,
      merge_commit_sha: pr.mergeCommitSha, head: ref(pr.head, pr.headSha), base: ref(pr.base, pr.baseSha),
    };
  }

  /** The PR object as `GET pulls/{n}` returns it, mergeability included. */
  private async fullJson(pr: Pr): Promise<Record<string, unknown>> {
    await this.refresh(pr);
    return { ...this.json(pr), merged: pr.merged, ...(await this.mergeability(pr)) };
  }

  private authorOf(pr: Pr): Identity {
    return pr.author === this.user.login ? { name: this.user.name, email: this.user.email } : { name: pr.author, email: `${pr.author}@users.noreply.github.com` };
  }

  private pull(n: number): Pr {
    const pr = this.pulls.get(n);
    if (!pr) throw new Error(`no PR #${n}`);
    return pr;
  }

  private async headOf(pr: Pr): Promise<string> {
    await this.refresh(pr);
    return pr.headSha;
  }

  // ---------- Git plumbing ----------

  /** A commit on `parent` (or a root commit) with `files` written (null deletes), through a scratch index. */
  private async commitFiles(parent: string | null, files: Record<string, string | null>, message: string, who: Identity): Promise<string> {
    const index = path.join(this.root.dir, `index-${randomBytes(6).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (parent) await this.git(['read-tree', parent], { env });
      for (const [p, content] of Object.entries(files)) {
        if (content === null) {
          await this.git(['update-index', '--force-remove', '--', p], { env });
        } else {
          const blob = await this.git(['hash-object', '-w', '--stdin'], { input: content });
          await this.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${p}`], { env });
        }
      }
      const tree = await this.git(['write-tree'], { env });
      return await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], { env: identityEnv(who, who), input: `${message}\n` });
    } finally {
      fs.rmSync(index, { force: true });
    }
  }

  /** The tree of merging `head` into `base`, or null if they conflict (`git merge-tree --write-tree`, Git 2.38+). */
  private async mergeTree(base: string, head: string): Promise<string | null> {
    const r = await this.run(['merge-tree', '--write-tree', base, head], { codes: [0, 1] });
    return r.code === 0 ? r.out.split('\n')[0]! : null;
  }

  private async isAncestor(a: string, b: string): Promise<boolean> {
    return (await this.run(['merge-base', '--is-ancestor', a, b], { codes: [0, 1] })).code === 0;
  }

  private async must(branch: string): Promise<string> {
    const sha = await this.tip(branch);
    if (!sha) throw new Error(`no branch ${branch} in the fake's repository`);
    return sha;
  }

  /** A commit sha, or a branch name, resolved to a commit. */
  private async resolve(ref: string): Promise<string | null> {
    if (SHA.test(ref)) return (await this.run(['cat-file', '-e', `${ref}^{commit}`], { codes: [0, 1, 128] })).code === 0 ? ref : null;
    return this.tip(ref);
  }

  private writeProtection(): void {
    const protectedRefs = this.rules.some((r) => r.type === 'pull_request') ? `refs/heads/${this.baseBranch}\n` : '';
    fs.writeFileSync(path.join(this.gitDir, 'fake-protected-refs'), protectedRefs);
  }

  /** Git with no user or system config (HOME is the fake's own dir), in the bare repo unless `cwd` says otherwise. */
  private run(args: string[], o: { cwd?: string; env?: Record<string, string>; input?: string; codes: number[] }): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.root.dir, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', ...o.env };
      const child = spawn('git', o.cwd ? args : ['--git-dir', this.gitDir, ...args], { cwd: o.cwd ?? this.root.dir, env });
      let out = '';
      let err = '';
      child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
      child.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== null && o.codes.includes(code)) resolve({ code, out: out.replace(/\n$/, '') });
        else reject(new Error(`git ${args.join(' ')} exited ${code}: ${err.trim()}`));
      });
      // A child that exits without reading its input closes the pipe first: its exit code says what happened.
      child.stdin.on('error', () => {});
      child.stdin.end(o.input ?? '');
    });
  }

  /** One mutation at a time (PR creation, merges, base commits), as GitHub serializes ref updates. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.catch(() => {}).finally(() => this.inflight.delete(p));
  }
}

class BaseMoved extends Error {}
const NOT_FOUND: Reply = { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } };

function identityEnv(author: Identity, committer: Identity): Record<string, string> {
  return { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email };
}
