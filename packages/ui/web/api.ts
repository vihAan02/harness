// The UI's API client (D-117; protocol.md §12). The page holds the session token from the launch handshake in
// sessionStorage and sends it as a bearer on every call; the bridge's /api/stream is read as a streaming fetch.
// Every string an answer carries is untrusted, so nothing here turns one into markup.
import type { DispatchKind, PendingApproval, ProjectSnapshot } from '@harness/protocol';

/** A refused or unreachable bridge call. `status` 0 means no answer at all: the fetch itself failed. */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Health = {
  device_id: string;
  principal: string;
  connection: string;
  provider_circuit: { kind: string; reason: string; at: string } | null;
  spent_today_usd: number;
  daily_budget_usd: number | null;
};
export type StreamState = 'live' | 'reconnecting' | 'harnessd_down' | 'session_expired';
export type Sent = { seqs: number[]; result: unknown };
export type Rec = Record<string, unknown>;

const SESSION_KEY = 'harness.session';
/** The first reconnect waits 1 s, the second 2 s, and every one after that 5 s (§12). */
const RECONNECT_MS = [1000, 2000, 5000];

type Obj = Record<string, unknown>;
type CallInit = { method?: string; body?: unknown };

function readToken(): string | null {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

function writeToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, token);
  } catch { /* storage may be unavailable; the token is best-effort */ }
}

function headers(token: string | null, hasBody: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (token !== null) h['Authorization'] = `Bearer ${token}`;
  if (hasBody) h['Content-Type'] = 'application/json';
  return h;
}

/** One request. 200 answers its JSON body; anything else throws the mapped ApiError. */
async function request(path: string, init: CallInit): Promise<Obj> {
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers: headers(readToken(), hasBody),
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'bridge_unreachable', 'the UI bridge could not be reached');
  }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  const obj: Obj = parsed !== null && typeof parsed === 'object' ? (parsed as Obj) : {};
  if (res.status === 200) return obj;
  const error: Obj = obj.error !== null && typeof obj.error === 'object' ? (obj.error as Obj) : {};
  const message = typeof error.message === 'string' ? error.message : `the bridge answered ${res.status}`;
  if (res.status === 401) {
    writeToken(null);
    throw new ApiError(401, 'session_expired', typeof error.message === 'string' ? error.message : 'the session ended');
  }
  const code = typeof error.code === 'string' ? error.code : `http_${res.status}`;
  throw new ApiError(res.status, code, message);
}

/** One request that answers the `{ result }` every non-launch /api route wraps its value in. */
async function send(path: string, init: CallInit): Promise<unknown> {
  return (await request(path, init)).result;
}

export const api = {
  /**
   * The launch fragment (#t=…) is swapped for a session token, which goes into sessionStorage; the fragment is then
   * cleared so a reload or a copied URL carries nothing (§12).
   */
  async startSession(): Promise<void> {
    const hash = location.hash;
    const launchToken = hash.startsWith('#t=') ? hash.slice('#t='.length) : '';
    const body = await request('/api/session', { method: 'POST', body: { launch_token: launchToken } });
    const token = body.session_token;
    if (typeof token !== 'string' || token.length === 0) throw new ApiError(0, 'no_session_token', 'the bridge did not return a session token');
    writeToken(token);
    history.replaceState(null, '', '/#/');
  },

  hasSession(): boolean {
    return readToken() !== null;
  },

  async snapshot(): Promise<ProjectSnapshot[]> {
    return (await send('/api/snapshot', {})) as ProjectSnapshot[];
  },
  async health(): Promise<Health> {
    return (await send('/api/health', {})) as Health;
  },
  async approvals(): Promise<PendingApproval[]> {
    return (await send('/api/approvals', {})) as PendingApproval[];
  },

  async approve(id: string, shownHash: string): Promise<unknown> {
    return send(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision: 'approve', shown_hash: shownHash } });
  },
  async deny(id: string): Promise<unknown> {
    return send(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision: 'deny' } });
  },

  async command(projectId: string, name: string, args: Rec, commandId: string): Promise<Sent> {
    return (await send('/api/command', { method: 'POST', body: { project_id: projectId, name, args, command_id: commandId } })) as Sent;
  },
  async dispatch(projectId: string, kind: DispatchKind, taskId: string, args: Rec, expected: Rec, commandId: string): Promise<Sent> {
    return (await send('/api/dispatch', { method: 'POST', body: { project_id: projectId, kind, task_id: taskId, args, expected, command_id: commandId } })) as Sent;
  },
  async providerReset(): Promise<unknown> {
    return send('/api/provider/reset', { method: 'POST', body: {} });
  },

  /**
   * Reads /api/stream for its lifetime. Lines are newline-delimited JSON: a snapshot, a `harnessd` up/down change, or a
   * keepalive, which is ignored. The body ending or failing reconnects with backoff; a 401 ends it for good. The
   * returned function aborts for good.
   */
  stream(on: { snapshot(s: ProjectSnapshot): void; state(s: StreamState): void }): () => void {
    let stopped = false;
    let isLive = false;
    let attempt = 0;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const emit = (s: StreamState): void => { if (!stopped) on.state(s); };
    const goLive = (): void => { if (!isLive) { isLive = true; emit('live'); } };
    const drop = (): void => { isLive = false; emit('reconnecting'); };
    const schedule = (): void => {
      if (stopped || timer !== null) return;
      const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 5000;
      attempt += 1;
      timer = setTimeout(() => { timer = null; void run(); }, delay);
    };

    const handleLine = (line: string, isFirst: boolean): void => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const o = parsed as { snapshot?: unknown; harnessd?: unknown };
      if (o.harnessd === 'down') { isLive = false; emit('harnessd_down'); return; }
      if (o.harnessd === 'up') { attempt = 0; goLive(); return; }
      if (o.snapshot !== null && typeof o.snapshot === 'object') { attempt = 0; goLive(); on.snapshot(o.snapshot as ProjectSnapshot); return; }
      if (isFirst) { attempt = 0; goLive(); } // any other first line means the stream is answering
    };

    const run = async (): Promise<void> => {
      if (stopped) return;
      controller = new AbortController();
      let res: Response;
      try {
        res = await fetch('/api/stream', { headers: headers(readToken(), false), signal: controller.signal });
      } catch {
        if (stopped) return;
        drop();
        schedule();
        return;
      }
      if (res.status === 401) { writeToken(null); emit('session_expired'); return; }
      if (!res.ok || res.body === null) { drop(); schedule(); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let first = true;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            handleLine(line, first);
            first = false;
          }
        }
      } catch { /* aborted, or the body failed: fall through to reconnect */ }
      if (stopped) return;
      drop();
      schedule();
    };

    void run();
    return () => {
      stopped = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      controller?.abort();
    };
  },
};

export type ApiClient = typeof api;
