// harnessd's local RPC for the UI bridge (D-117; protocol.md §12). The device key, the views, approvals and signing
// stay in harnessd: the bridge asks over this socket.
// - A Unix socket, owner-only, in ~/.harness/run (0700). Agents can't read ~/.harness, and their sandbox can't open
//   Unix sockets (F-119), so only this OS user's processes reach it.
// - Every request carries the token from ~/.harness/run/uirpc.token, new at each start; a wrong one closes the
//   connection.
// - Newline-delimited JSON: { id, token, method, params } → { id, ok, result | error }.
//   `events` subscribes the connection: whenever a project's snapshot changes, it gets
//   { stream: id, project_id, seq, snapshot_patch: { op: "replace", value } }.
// - Approving binds the human's click to what they were shown: the exact request id and its hash. harnessd re-hashes
//   what it's about to run before it acts on any approval, so a change after the request needs a new one anyway.
// - Commands are an allowlist of human commands that need no dispatch. A lifecycle command (assign, reopen, resume,
//   abandon, complete, integrate) is a `dispatch`: harnessd builds and signs it from its own view (D-112).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DispatchKind, ProjectSnapshot } from '@harness/protocol';
import { DISPATCH_KINDS } from '@harness/protocol/signing';
import { Approvals } from './approvals.ts';
import { ensureDir } from './home.ts';

/** What the RPC needs from harnessd. */
export type UiRpcHost = {
  projects(): string[];
  snapshot(projectId: string): ProjectSnapshot;
  health(): Record<string, unknown>;
  approvals: Approvals;
  command(projectId: string, name: string, args: Record<string, unknown>, commandId: string): Promise<{ seqs: number[]; result: unknown }>;
  /** Closes the provider circuit (D-116): the human fixed the account. */
  resetProvider(): void;
  /** A human's lifecycle command, signed by harnessd (D-112). */
  dispatch(projectId: string, kind: DispatchKind, taskId: string, o: {
    agentId?: string; text?: string; reason?: string; summary?: string;
    expected?: { task_sha256?: string; pr_number?: number; head_sha?: string; base_sha?: string };
  }, commandId: string): Promise<{ seqs: number[]; result: unknown }>;
  log(m: string): void;
};

export class UiRpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_LINE = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
/** Human commands the UI may send without a dispatch (protocol.md §12). */
const COMMANDS = ['task.create', 'message.send', 'task.unblock', 'land.cancel'];

export class UiRpc {
  socket: string;
  tokenFile: string;
  host: UiRpcHost;
  pollMs: number;
  server: net.Server | null = null;
  token = '';
  conns = new Set<net.Socket>();
  timer: NodeJS.Timeout | null = null;
  /** Each subscribed connection's stream id and the last snapshot it was sent, per project. */
  streams = new Map<net.Socket, { id: unknown; sent: Map<string, string> }>();

  constructor(o: { socket: string; host: UiRpcHost; pollMs?: number }) {
    this.socket = o.socket;
    this.tokenFile = path.join(path.dirname(o.socket), 'uirpc.token');
    this.host = o.host;
    this.pollMs = o.pollMs ?? 500;
  }

  async start(): Promise<void> {
    const dir = path.dirname(this.socket);
    ensureDir(dir);
    fs.chmodSync(dir, 0o700);
    // A stale socket from a crash: harnessd holds the home's lock (D-113), so nothing else serves it.
    try {
      if (fs.lstatSync(this.socket).isSocket()) fs.rmSync(this.socket);
      else throw new Error(`${this.socket} exists and isn't a socket`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    this.token = randomBytes(32).toString('hex');
    fs.rmSync(this.tokenFile, { force: true });
    fs.writeFileSync(this.tokenFile, `${this.token}\n`, { mode: 0o600, flag: 'wx' });
    const server = net.createServer((c) => this.accept(c));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socket, () => { server.off('error', reject); resolve(); });
    });
    // The 0700 directory already keeps everyone else out; the socket itself is owner-only too.
    fs.chmodSync(this.socket, 0o600);
    this.server = server;
    this.timer = setInterval(() => this.push(), this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.conns) c.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(this.socket, { force: true });
    fs.rmSync(this.tokenFile, { force: true });
  }

  accept(c: net.Socket): void {
    this.conns.add(c);
    let buf = '';
    let chain = Promise.resolve();
    c.setEncoding('utf8');
    c.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE && !buf.includes('\n')) return void c.destroy();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) chain = chain.then(() => this.handle(c, line));
      }
    });
    c.on('close', () => { this.conns.delete(c); this.streams.delete(c); });
    c.on('error', () => {});
  }

  send(c: net.Socket, m: unknown): void {
    if (!c.destroyed) c.write(`${JSON.stringify(m)}\n`);
  }

  authorized(token: unknown): boolean {
    if (typeof token !== 'string' || token.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(this.token));
  }

  async handle(c: net.Socket, line: string): Promise<void> {
    let m: { id?: unknown; token?: unknown; method?: unknown; params?: unknown };
    try { m = JSON.parse(line) as typeof m; } catch { return void c.destroy(); }
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return void c.destroy();
    if (!this.authorized(m.token)) {
      this.send(c, { id: m.id ?? null, ok: false, error: { code: 'unauthorized', message: 'bad token' } });
      return void c.end();
    }
    const params = (typeof m.params === 'object' && m.params !== null && !Array.isArray(m.params) ? m.params : {}) as Record<string, unknown>;
    try {
      this.send(c, { id: m.id ?? null, ok: true, result: await this.call(c, m.id, String(m.method), params) });
    } catch (e) {
      // A refusal with its own code (harnessd's, or the coordinator's answer to a command) reaches the UI with it.
      const code = (e as { code?: unknown }).code;
      const known = e instanceof UiRpcError || (typeof code === 'string' && /^[a-z_]{1,40}$/.test(code));
      const error = known ? { code: code as string, message: (e as Error).message.slice(0, 500) } : { code: 'internal', message: (e as Error).message.slice(0, 500) };
      if (!(e instanceof UiRpcError)) this.host.log(`uirpc ${String(m.method)}: ${(e as Error).message}`);
      this.send(c, { id: m.id ?? null, ok: false, error });
    }
  }

  project(params: Record<string, unknown>): string {
    const p = params.project_id;
    if (typeof p !== 'string' || !this.host.projects().includes(p)) throw new UiRpcError('not_found', `no project ${String(p)} on this device`);
    return p;
  }

  async call(c: net.Socket, id: unknown, method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'snapshot':
        return params.project_id === undefined ? this.host.projects().map((p) => this.host.snapshot(p)) : [this.host.snapshot(this.project(params))];
      case 'events': {
        // The current snapshot of each project follows at once, then each change.
        this.streams.set(c, { id, sent: new Map() });
        queueMicrotask(() => this.push());
        return { subscribed: this.host.projects() };
      }
      case 'health':
        return this.host.health();
      case 'pending_approvals':
        return this.host.approvals.pending().map((r) => ({
          id: r.id, project_id: r.projectId, task_id: r.taskId, kind: r.kind ?? 'setup', command: r.command, manifests: r.manifests, hash: r.hash, requested_at: r.requestedAt,
        }));
      case 'approve': {
        const req = this.request(params.id);
        if (typeof params.shown_hash !== 'string' || !HASH.test(params.shown_hash) || params.shown_hash !== req.hash) {
          throw new UiRpcError('conflict', `approval ${req.id} isn't what was shown: show it again and approve that`);
        }
        this.host.approvals.approve(req.id);
        this.host.log(`approved ${req.kind ?? 'setup'} ${req.id} for ${req.taskId} from the UI`);
        return { approved: req.id };
      }
      case 'deny': {
        const req = this.request(params.id);
        this.host.approvals.deny(req.id);
        this.host.log(`denied ${req.kind ?? 'setup'} ${req.id} for ${req.taskId} from the UI`);
        return { denied: req.id };
      }
      case 'command': {
        const project = this.project(params);
        const name = params.name;
        const args = params.args;
        if (typeof name !== 'string' || !COMMANDS.includes(name)) throw new UiRpcError('forbidden', `the UI can't send ${String(name)} without a dispatch`);
        if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new UiRpcError('bad_request', 'args must be an object');
        if (name === 'task.create' && (args as Record<string, unknown>).assignee_agent_id !== undefined) {
          throw new UiRpcError('forbidden', 'assigning a task needs a dispatch: create it, then assign it');
        }
        if (typeof params.command_id !== 'string' || !UUID.test(params.command_id)) throw new UiRpcError('bad_request', 'command_id must be a UUID');
        const r = await this.host.command(project, name, args as Record<string, unknown>, params.command_id);
        return { seqs: r.seqs, result: r.result };
      }
      case 'provider_reset':
        this.host.resetProvider();
        return { reset: true };
      case 'dispatch': {
        const project = this.project(params);
        const kind = params.kind as DispatchKind;
        if (!DISPATCH_KINDS.includes(kind)) throw new UiRpcError('bad_request', `kind must be one of ${DISPATCH_KINDS.join(', ')}`);
        if (typeof params.task_id !== 'string' || !ID.test(params.task_id)) throw new UiRpcError('bad_request', 'task_id is missing or malformed');
        if (typeof params.command_id !== 'string' || !UUID.test(params.command_id)) throw new UiRpcError('bad_request', 'command_id must be a UUID');
        // { args: the command's own args, expected: what the human saw } (protocol.md §12; the CLI's PB2b sends the same).
        const object = (v: unknown, what: string) => {
          if (v === undefined) return {} as Record<string, unknown>;
          if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new UiRpcError('bad_request', `${what} must be an object`);
          return v as Record<string, unknown>;
        };
        const args = object(params.args, 'args');
        const expected = object(params.expected, 'expected');
        const text = (o: Record<string, unknown>, k: string) => (o[k] === undefined ? undefined : typeof o[k] === 'string' ? o[k] as string : (() => { throw new UiRpcError('bad_request', `${k} must be text`); })());
        const r = await this.host.dispatch(project, kind, params.task_id, {
          ...(text(args, 'assignee_agent_id') ? { agentId: text(args, 'assignee_agent_id') } : {}), ...(text(args, 'text') !== undefined ? { text: text(args, 'text') } : {}),
          ...(text(args, 'reason') ? { reason: text(args, 'reason') } : {}), ...(text(args, 'summary') ? { summary: text(args, 'summary') } : {}),
          expected: {
            ...(text(expected, 'task_sha256') ? { task_sha256: text(expected, 'task_sha256') } : {}),
            ...(expected.pr_number !== undefined ? { pr_number: expected.pr_number as number } : {}),
            ...(text(expected, 'head_sha') ? { head_sha: text(expected, 'head_sha') } : {}), ...(text(expected, 'base_sha') ? { base_sha: text(expected, 'base_sha') } : {}),
          },
        }, params.command_id);
        return { seqs: r.seqs, result: r.result };
      }
      default:
        throw new UiRpcError('bad_request', `unknown method ${method.slice(0, 40)}`);
    }
  }

  request(id: unknown) {
    if (typeof id !== 'string' || !ID.test(id)) throw new UiRpcError('bad_request', 'id is missing or malformed');
    const req = this.host.approvals.pending().find((r) => r.id === id); // exact, never a prefix
    if (!req) throw new UiRpcError('not_found', `no pending approval ${id}`);
    return req;
  }

  /** Sends each subscriber the snapshots that changed since it last heard. */
  push(): void {
    if (!this.streams.size) return;
    for (const p of this.host.projects()) {
      let snap: ProjectSnapshot;
      try { snap = this.host.snapshot(p); } catch { continue; }
      const { taken_at: _at, ...stable } = snap;
      const key = JSON.stringify(stable);
      for (const [c, s] of this.streams) {
        if (s.sent.get(p) === key) continue;
        s.sent.set(p, key);
        this.send(c, { stream: s.id, project_id: p, seq: snap.head_seq, snapshot_patch: { op: 'replace', value: snap } });
      }
    }
  }
}
