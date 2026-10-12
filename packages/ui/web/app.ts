// The UI shell (D-117; protocol.md §12): the header, the banner and the router. Each route lazily imports its view,
// which mounts into #view and re-renders through the context it is given. Strings from a snapshot, an approval, the
// health reply or an error are untrusted: they go into the page as text nodes only.
import type { PendingApproval, ProjectSnapshot } from '@harness/protocol';
import { ApiError, api } from './api.ts';
import type { ApiClient, Health, StreamState } from './api.ts';
import { clear, el, text } from './dom.ts';

export type ViewContext = {
  api: ApiClient;
  snapshot(): ProjectSnapshot | null;
  approvals(): PendingApproval[] | null;
  health(): Health | null;
  /** The banner's words while actions can't be sent, else null. Views disable their controls while it is set. */
  offline(): string | null;
  onChange(fn: () => void): () => void;
  navigate(route: string): void;
  refreshApprovals(): Promise<void>;
  params: string[];
};
export type View = { mount(root: HTMLElement, ctx: ViewContext): () => void };

const SESSION_MESSAGE = 'Open the UI with: node packages/ui/src/main.ts open';
const NO_PROJECTS = "This Mac's harnessd has no projects.";
const NOT_BUILT = "This part of the UI isn't built yet.";
const HEALTH_MS = 10_000;
const APPROVALS_MS = 5_000;
const SNAPSHOT_RETRY_MS = 2_000;

/** A route name (the first hash segment) to the view module that serves it. */
const routes: Record<string, string> = {
  '': './view/board.ts',
  task: './view/task.ts',
  approval: './view/approval.ts',
  integration: './view/integration.ts',
};

function must(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the page has no #${id}`);
  return node;
}

const topEl = must('top');
const bannerEl = must('banner');
const viewEl = must('view');

let projects = new Map<string, ProjectSnapshot>();
let health: Health | null = null;
let approvals: PendingApproval[] | null = null;
let streamState: StreamState = 'reconnecting';
let lastError: ApiError | null = null;

let unmountView: (() => void) | null = null;
let mountedName: string | null = null;
let mountedParams: string[] = [];
const listeners = new Set<() => void>();

/** Bumped by every route() call: an import that resolves after a later call must not mount (its generation is stale). */
let routeGeneration = 0;
/** The name and params of the route whose view import is in flight, so a repeat call for it is a no-op. */
let pendingRoute: { name: string; params: string[] } | null = null;

function asApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, 'bridge_unreachable', e instanceof Error ? e.message : String(e));
}

function currentProject(): ProjectSnapshot | null {
  const want = new URLSearchParams(location.search).get('project');
  if (want !== null) {
    const hit = projects.get(want);
    if (hit !== undefined) return hit;
  }
  for (const p of projects.values()) return p;
  return null;
}

function currentApprovals(): PendingApproval[] | null {
  if (approvals === null) return null;
  const project = currentProject();
  if (project === null) return approvals;
  return approvals.filter((a) => a.project_id === project.project_id);
}

/** The banner, first match wins (§12). Its text is also what `offline()` returns. */
function bannerText(): string | null {
  if (streamState === 'session_expired' || lastError?.code === 'session_expired') {
    return 'Session ended. Run node packages/ui/src/main.ts open again.';
  }
  if (lastError !== null && lastError.status === 0) return "Can't reach the UI bridge.";
  if (streamState === 'harnessd_down' || lastError?.code === 'unavailable' || lastError?.code === 'timeout') {
    return "harnessd isn't answering. Actions wait until it's back.";
  }
  if (streamState === 'reconnecting') return 'Reconnecting…';
  switch (currentProject()?.connection) {
    case 'connecting': return 'harnessd is connecting to the coordinator; actions wait.';
    case 'server_identity_mismatch': return "The coordinator didn't prove its key. Nothing is trusted. Check the tunnel (harness doctor).";
    case 'replaced': return "Another harnessd took over this device's connection.";
    case 'refused': return 'The coordinator refused this device. Check its keys (harness doctor).';
    case 'coordinator_changed': return "A new coordinator database: harnessd won't mix state. See the runbook.";
    default: return null;
  }
}

function syncOffline(): void {
  if (bannerText() === null) delete document.body.dataset.offline;
  else document.body.dataset.offline = 'true';
}

function renderChrome(): void {
  const project = currentProject();
  const principal = health?.principal ?? project?.principal ?? null;
  const device = health?.device_id ?? project?.device_id ?? null;
  clear(topEl);
  topEl.append(
    el('span', { class: 'brand' }, 'Harness'),
    ...(project !== null ? [el('span', { class: 'project' }, project.project_id)] : []),
    ...(principal !== null && device !== null ? [el('span', { class: 'who' }, `you: ${principal} on ${device}`)] : []),
    el('nav', {},
      el('a', { href: '#/' }, 'Board'),
      el('a', { href: '#/integration' }, 'Integration'),
    ),
  );

  const words = bannerText();
  clear(bannerEl);
  bannerEl.hidden = words === null;
  if (words !== null) bannerEl.append(text(words));
  syncOffline();
}

function context(params: string[]): ViewContext {
  return {
    api,
    snapshot: currentProject,
    approvals: currentApprovals,
    health: () => health,
    offline: bannerText,
    onChange: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    navigate: (route) => { location.hash = route; },
    refreshApprovals,
    params,
  };
}

function showPlain(message: string): void {
  if (unmountView) { unmountView(); unmountView = null; }
  listeners.clear();
  mountedName = null;
  mountedParams = [];
  clear(topEl);
  clear(bannerEl);
  clear(viewEl);
  viewEl.append(el('p', { class: 'plain' }, message));
}

function showNotBuilt(): void {
  clear(viewEl);
  viewEl.append(el('p', { class: 'muted' }, NOT_BUILT));
}

function sameParams(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function route(): Promise<void> {
  const gen = ++routeGeneration;
  if (!api.hasSession()) { showPlain(SESSION_MESSAGE); return; }
  const parts = location.hash.replace(/^#/, '').split('/').filter((s) => s !== '');
  const name = parts[0] ?? '';
  const params = parts.slice(1);
  if (mountedName === name && sameParams(mountedParams, params)) return;
  // A second call for a route whose import is already in flight is a no-op: it would mount the same view again.
  if (pendingRoute !== null && pendingRoute.name === name && sameParams(pendingRoute.params, params)) return;

  // Unmount the previous view before mounting the next.
  if (unmountView) { unmountView(); unmountView = null; }
  listeners.clear();
  mountedName = null;
  mountedParams = [];
  clear(viewEl);

  if (currentProject() === null) { viewEl.append(el('p', { class: 'muted' }, 'Loading…')); return; }

  const spec = Object.hasOwn(routes, name) ? routes[name] : undefined;
  if (spec === undefined) { showNotBuilt(); return; }
  pendingRoute = { name, params };
  let view: View | undefined;
  try {
    const mod = (await import(spec)) as { default?: View };
    view = mod.default;
  } catch {
    view = undefined;
  }
  pendingRoute = null;
  // A later route() superseded this one while its import was in flight: don't mount over the newer call's view.
  if (gen !== routeGeneration) return;
  if (view === undefined || typeof view.mount !== 'function') { showNotBuilt(); return; }
  unmountView = view.mount(viewEl, context(params));
  mountedName = name;
  mountedParams = params;
}

/** Re-render the chrome, tell the mounted view, and (for the loading-to-loaded transition) route again. */
function notify(): void {
  renderChrome();
  for (const fn of [...listeners]) fn();
  void route();
}

async function refreshSnapshot(): Promise<void> {
  let ok = false;
  try {
    const list = await api.snapshot();
    if (Array.isArray(list)) {
      projects = new Map(list.map((p) => [p.project_id, p]));
      lastError = null;
      ok = true;
    }
  } catch (e) {
    lastError = asApiError(e);
  }
  if (!ok) scheduleSnapshotRetry();
  notify();
}

let snapshotRetry: ReturnType<typeof setTimeout> | null = null;
/** The first snapshot failing keeps the banner and retries every 2 s until one answer arrives. */
function scheduleSnapshotRetry(): void {
  if (snapshotRetry !== null) return;
  snapshotRetry = setTimeout(() => { snapshotRetry = null; void refreshSnapshot(); }, SNAPSHOT_RETRY_MS);
}

async function refreshHealth(): Promise<void> {
  try {
    health = await api.health();
    lastError = null;
  } catch (e) {
    lastError = asApiError(e);
  }
  notify();
}

async function refreshApprovals(): Promise<void> {
  try {
    const list = await api.approvals();
    if (Array.isArray(list)) approvals = list;
  } catch (e) {
    lastError = asApiError(e);
  }
  notify();
}

function onSnapshot(snap: ProjectSnapshot): void {
  projects.set(snap.project_id, snap);
  lastError = null;
  notify();
  void refreshApprovals();
}

function onStreamState(state: StreamState): void {
  streamState = state;
  notify();
}

async function start(): Promise<void> {
  window.addEventListener('hashchange', () => { void route(); });
  void refreshHealth();
  void refreshApprovals();
  await refreshSnapshot();
  // An empty list is "no projects"; a failed snapshot keeps the banner and retries (refreshSnapshot).
  if (projects.size === 0 && lastError === null) { showPlain(NO_PROJECTS); return; }
  api.stream({ snapshot: onSnapshot, state: onStreamState });
  setInterval(() => { void refreshHealth(); }, HEALTH_MS);
  setInterval(() => { void refreshApprovals(); }, APPROVALS_MS);
  await route();
}

async function boot(): Promise<void> {
  // The launcher opens /launch#t=<token>: swap the fragment for a session before anything else.
  if (location.hash.startsWith('#t=')) {
    try {
      await api.startSession();
    } catch {
      showPlain(SESSION_MESSAGE);
      return;
    }
  }
  if (!api.hasSession()) { showPlain(SESSION_MESSAGE); return; }
  await start();
}

void boot();
