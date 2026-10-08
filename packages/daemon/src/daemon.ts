// harnessd v0 (0A item 4; docs/local-runtime.md). The per-device execution and security boundary
// (D-32): it prepares and tears down task workspaces, owns their Git writes, runs approved setup
// commands sandboxed, hands out ports and agent config dirs, tracks agent processes, and keeps a
// connection to the coordination server. It runs agent sessions only through @harness/adapters
// (D-17). Acting on task assignments arrives with the lifecycle (item 9).
import { createHash, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeAdapter, type AgentAdapter, type Auth, type HarnessTool, type Observation, type SessionHandle, type SessionSpec, type SessionStatus,
} from '@harness/adapters';
import type { EventMessage, ProjectSnapshot } from '@harness/protocol';
import { Approvals, setupHash, testHash } from './approvals.ts';
import { loadConfig, resolveSecrets, type LocalConfig, type ProjectConfig } from './config.ts';
import { branchTip, changedPaths, commitAll, createWorktree, git, gitCommonDir, guardWorktrees, removeWorktree, TASK_ID, taskBranch } from './git.ts';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';
import { ServerLink, type LinkState } from './link.ts';
import { checkAuthTarget, Handshake, loadDeviceKey } from './identity.ts';
import { Journal } from './journal.ts';
import { advanceBaseRef, baseRef, fetchBase, gitRemote, pushBranch } from './remote.ts';
import { ghToken, GitHubClient } from './github.ts';
import { publishHash, scanPublish } from './publish.ts';
import { prBody, prTitle } from './prbody.ts';
import { Poller } from './prpoll.ts';
import { integrateRemote } from './integrate-remote.ts';
import { codeownersAt, requiredReviewers } from './codeowners.ts';
import { acquireLock } from './lockfile.ts';
import { effectivePolicy, readRepoConfig, type RepoConfig } from './repo-config.ts';
import { agentConfigDir, PortAllocator, portEnv, type PortBlock } from './resources.ts';
import { runSetup } from './setup.ts';
import { renderMessage, renderTask, reopenedText, resumedText, type MessageForAgent, type TaskForAgent } from './envelope.ts';
import { readRepoInstructions, sessionInstructions } from './instructions.ts';
import {
  addIntegrationWorktree, advanceBase, blobsAt, changedBetween, deleteMergedBranch, diffExcerpt, mergeCommit, removeIntegrationWorktree,
} from './integrate.ts';
import { contains, syncWorktree, unresolved } from './sync.ts';
import { ReadTracker, type ReadReport } from './reads.ts';
import { parseShellReads } from './shellreads.ts';
import { providerModel, providerName, resolveProvider, type ResolvedProvider } from './provider.ts';
import { killOrphans, processStart, Sessions, type OrphanReport, type SessionRecord } from './supervision.ts';
import { findTrustPostgres, trustRefusal, type TrustLogin } from './localsvc.ts';
import { harnessTools } from './tools.ts';
import { waitOutcomeText } from './tools/waits.ts';
import { LeaseKeeper, type LeaseFaults } from './leases.ts';
import { readPolicyFor } from './readpolicy.ts';
import { ProjectView, type MessageInfo, type WaitInfo } from './view.ts';
import { snapshotOf } from './snapshot.ts';
import { screenText } from './screen.ts';
import { MIN_START_USD, ProviderCircuit, RATE_LIMIT_STOP, SpendLedger } from './budget.ts';
import { UiRpc } from './uirpc.ts';

export type TaskWorkspace = {
  projectId: string; taskId: string; worktree: string; branch: string;
  ports: PortBlock; configDir: string;
  env: Record<string, string>; // harness-set: the port block (D-68)
  secrets: Record<string, string>; // the task's allowlisted secrets (D-52)
};
export type AgentRef = { id: string; name: string; vendor: string };
/** One agent session harnessd is running for a task. */
export type RunningAgent = {
  sessionId: string; projectId: string; taskId: string; agent: AgentRef; workspace: TaskWorkspace;
  adapter: AgentAdapter; handle: SessionHandle; record: SessionRecord;
  lastUsage: Extract<Observation, { kind: 'usage' }> | null;
  /** Why harnessd stopped it, when it did (D-116): provider_auth, provider_billing, budget, rate_limited. */
  stopReason?: string;
  /** Rate-limit errors seen in this session. */
  rateLimits?: number;
  /** Tool calls by tool, and calls the permission rules denied, over the whole session (H-07, M5b). */
  tools: { calls: Record<string, number>; denied: number };
  /** The status as of the observation being handled; the adapter's live status may already be ahead. Only `ended` ends a session. */
  status: SessionStatus;
  /** Observed-claim reconciliation (D-70): the last full set reported, and whether hooks reported since. */
  diff: { last: string | null; hooksSince: boolean; running: Promise<void> | null; timer: NodeJS.Timeout | null }; // running: the queue of diffs
  /** Read capture (0B item 1, D-88): what the agent read, hashed and reported with readset.add. */
  reads: ReadTracker;
  /**
   * The missed-hook monitor (D-47, H-03): every tool call from the stream, whether a post hook saw it, and
   * how it ended. A call that succeeded with no hook means read or edit capture missed it.
   */
  monitor: { calls: Map<string, { tool: string; hooked: boolean; result: 'ok' | 'error' | null }>; observed: number; missed: number; rejected: number; unparsedShell: number };
  /**
   * Sync at turn end (D-53): landed notices held until the branch has the new base; whether a sync is due;
   * the one running (deliveries wait for it); and, after a conflict, what the human must resolve. `forced`
   * syncs with no notice held, and `after` is what to tell the agent once it has: a land it waited for (D-106).
   */
  sync: {
    held: MessageInfo[]; pending: boolean; running: Promise<void> | null; blocked: { target: string; oldBase: string } | null; retryGuard?: boolean;
    forced?: boolean; after: { id: string; text: string; label: string }[];
  };
  done: Promise<void>;
};

const SYNC_HOLD = 'The harness is updating your branch with work that just landed. Wait for its notice, then carry on.';
const BLOCKED_HOLD = 'This task is paused: updating your branch with work that landed conflicted, and your human is resolving it. Stop and wait.';
/** The most paths one report to the server lists (its own cap, kept under its message size limit). */
const MAX_REPORT_PATHS = 5000;
/**
 * What a file name that reaches another agent's notice may not contain: control characters (C0 and C1),
 * format characters such as bidi overrides, and line and paragraph separators. Any of them could forge a
 * line of the notice or hide text in it (D-25, D-99). Nor `<` or `>`: a notice may arrive inside a
 * `<system-reminder>`, which a name could close early (D-100).
 */
const UNSAFE_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;
/** How long a clean D-119 check (no password-less loopback Postgres) holds before an agent start checks again. */
const TRUST_PG_TTL_MS = 60_000;
/** Nobody approved a setup or test command in time (D-52); a land that hits it fails as `not_approved`. */
export class ApprovalTimeout extends Error {}
export type DaemonOptions = {
  home: Home; config?: LocalConfig;
  log?: (msg: string) => void; onEvent?: (e: EventMessage) => void;
  onObservation?: (run: RunningAgent, o: Observation) => void;
  heartbeatMs?: number; approvalPollMs?: number;
  /** How long a setup or test command waits for `harness approve` before giving up. Default 30 minutes. */
  approvalTimeoutMs?: number;
  /** How long stop() waits for agents, lifecycles and lands before closing the link anyway (#74). Default 30 s. */
  stopDeadlineMs?: number;
  /** After `task.completed`, how long to let the agent finish its turn before stopping it. Default 60 s. */
  finishGraceMs?: number;
  /** How often a running agent's worktree is diffed for edits the hooks missed (D-70). Default 15 s; also at every turn end. */
  diffIntervalMs?: number;
  /** The model endpoint and key. Default: resolved from the config and harnessd's environment (D-87); see provider.ts. */
  provider?: ResolvedProvider;
  /** Overrides only the endpoint and key (tests point it at a scripted mock); the model settings still come from the config. */
  auth?: Auth;
  adapters?: Record<string, AgentAdapter>;
  /** How often held leases are renewed. Default: about a third of each lease's TTL (D-97). */
  leaseRenewMs?: number;
  /**
   * Fault injection, for tests only. `leases`: T-2. `crashAt`: harnessd SIGKILLs itself at that named point
   * (D-113's crash windows): `after_assignment_receipt`, `during_setup`, `after_report_done`.
   */
  faults?: { leases?: LeaseFaults; crashAt?: string; beforeArm?: () => Promise<void> };
  /** This device's key, with device-key auth (D-111). Default: ~/.harness/device.key. */
  deviceKey?: KeyObject;
  /** GitHub for a GitHub-mode project (D-114). Default: the human's own `gh` login. Tests point it at a fake. */
  github?: { token?: () => Promise<string>; retryMs?: number };
  /** How often GitHub-mode projects' base and PRs are polled (D-114). Default 60 s. */
  pollMs?: number;
  /** The UI bridge's socket (D-117; protocol.md §12): `~/.harness/run/harnessd.sock` in production. Off when unset. */
  uiSocket?: string;
  uiPollMs?: number;
  /** The D-119 check for loopback Postgres that takes password-less logins (TH-22), for tests. Default: findTrustPostgres. */
  localServices?: { check?: () => Promise<TrustLogin[]> };
};

/** What a security review releases (D-118): one message, its exact text. */
function reviewHash(id: string, text: string): string {
  return createHash('sha256').update(JSON.stringify({ v: 1, kind: 'security_review', id, text })).digest('hex');
}

/** Whether `p` settled (either way) within `ms`. Never rejects; leaves no timer behind. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([p.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Daemon {
  home: Home;
  config: LocalConfig;
  log: (msg: string) => void;
  o: DaemonOptions;
  approvals: Approvals;
  spend: SpendLedger;
  circuit: ProviderCircuit;
  sessions: Sessions;
  ports: PortAllocator;
  link: ServerLink | null = null;
  orphans: OrphanReport[] = [];
  stopping = false;
  adapters: Record<string, AgentAdapter>;
  running = new Map<string, RunningAgent>(); // by task id
  views = new Map<string, ProjectView>(); // rebuilt from each project's log at start (D-78)
  delivering = new Set<string>(); // message ids being injected right now
  delivered = new Set<string>(); // acknowledged in this process, before the server's event comes back
  lifecycles = new Map<string, Promise<void>>(); // per task while in flight, so assigned → completed never overlap
  landing = new Map<string, Promise<void>>(); // per project: lands run one at a time (D-93)
  landsInFlight = 0; // lands (and recoveries) running now: stop() waits for them
  /** Aborted when harnessd stops: setup commands and land tests are killed at once (#74). */
  stopSignal = new AbortController();
  /** T-5 (D-118): messages held for review now, and ones their human denied (never delivered). */
  reviewing = new Set<string>();
  screenDenied = new Set<string>();
  /** Setup and test commands running now, by name; their process groups are recorded in ~/.harness/procs. */
  procsRunning = new Set<string>();
  leases: LeaseKeeper; // renews this device's tasks' leases, presents them at land (D-97)
  linkState: LinkState = 'connecting'; // for status and health (D-111)
  ui: UiRpc | null = null;
  /** The write-ahead journal (D-113), keyed by the coordinator's epoch, so it exists from the first welcome. */
  journalInstance: Journal | null = null;
  releaseLock: (() => void) | null = null;
  /** Until startup recovery has run, lifecycle events wait here, per task, so recovery always goes first (D-113). */
  recovering = true;
  buffered = new Map<string, EventMessage[]>();
  recovered: Promise<void> = Promise.resolve();
  githubToken: (() => Promise<string>) | null = null;
  githubLogin: string | null = null;
  poller: Poller | null = null;
  trustPg: { at: number; hits: Promise<TrustLogin[]> } | null = null; // the last D-119 check

  constructor(o: DaemonOptions) {
    this.o = o;
    this.home = o.home;
    this.config = o.config ?? loadConfig(o.home);
    this.log = o.log ?? (() => {});
    this.approvals = new Approvals(this.home);
    this.spend = new SpendLedger(this.home);
    this.circuit = new ProviderCircuit(this.home);
    this.sessions = new Sessions(this.home);
    this.ports = new PortAllocator(this.home, this.config.limits.portRange, this.config.limits.portsPerAgent, this.config.limits.maxConcurrentAgents);
    this.adapters = o.adapters ?? { claude: new ClaudeAdapter() };
    for (const p of this.config.projects) this.views.set(p.id, new ProjectView(p.id));
    this.leases = new LeaseKeeper({
      view: (projectId) => this.view(projectId),
      send: async (projectId, name, args, asAgent) => (await this.link!.command(projectId, name, args, asAgent)).result,
      log: (msg) => this.log(msg),
      ...(o.leaseRenewMs ? { renewMs: o.leaseRenewMs } : {}),
      ...(o.faults?.leases ? { faults: o.faults.leases } : {}),
      deviceId: this.config.deviceId,
      projects: () => this.config.projects.map((p) => p.id),
    });
  }

  async start(): Promise<void> {
    for (const d of [this.home.root, this.home.worktrees, this.home.scratch, this.home.sessions, this.home.vendor, this.home.logs, this.home.pending]) ensureDir(d);
    ensureDir(path.join(this.home.root, 'integration'));
    // Git in a worktree, a land's integration checkout or scratch never follows the `.git` file there (TH-25).
    guardWorktrees({ roots: [this.home.worktrees, this.home.scratch, path.join(this.home.root, 'integration')], repos: this.config.projects.map((p) => p.repo) });
    // First, before anything that could touch another harnessd's agents (D-113).
    this.releaseLock = await acquireLock(path.join(this.home.root, 'harnessd.lock'));
    this.orphans = await killOrphans(this.sessions);
    await this.killSetupOrphans();
    for (const o of this.orphans) {
      this.log(`killed orphaned agent process ${o.pid} (session ${o.sessionId}, task ${o.taskId}); changed: ${o.changedPaths.join(', ') || 'nothing'}`);
    }
    const saved = readJson<{ cursors: Record<string, number> }>(this.home.state, { cursors: {} }).cursors;
    const deviceKey = this.config.auth === 'device-key' ? (this.o.deviceKey ?? loadDeviceKey(this.home)) : null;
    checkAuthTarget(this.config); // before anything connects
    this.link = new ServerLink({
      url: this.config.serverUrl,
      handshake: (subscribe) => new Handshake({ config: this.config, deviceKey, clientKind: 'harnessd', subscribe }),
      cursors: Object.fromEntries(this.config.projects.map((p) => [p.id, saved[p.id] ?? 0])),
      onEvent: (e, replayed) => this.onEvent(e, replayed),
      onCursor: () => writeJsonAtomic(this.home.state, { cursors: this.link!.cursors }),
      ...(this.o.heartbeatMs ? { heartbeatMs: this.o.heartbeatMs } : {}),
      log: this.log,
      onState: (state) => {
        this.linkState = state;
        if (state === 'server_identity_mismatch') this.log('the coordinator did not prove its pinned key: nothing from it is trusted until one that does answers (D-111)');
      },
    });
    this.link.start();
    // Recovery runs as soon as the logs are caught up, whether or not anyone awaits ready().
    this.recovered = this.link.whenReady().then(() => this.link!.whenCaughtUp()).then(() => this.recover())
      .catch((e: Error) => this.log(`recovery failed: ${e.message}`));
    if (this.o.uiSocket) {
      this.ui = new UiRpc({
        socket: this.o.uiSocket, ...(this.o.uiPollMs ? { pollMs: this.o.uiPollMs } : {}),
        host: {
          projects: () => this.config.projects.map((p) => p.id),
          snapshot: (projectId) => this.snapshot(projectId),
          health: () => this.health(),
          approvals: this.approvals,
          command: (projectId, name, args, commandId) => this.link!.command(projectId, name, args, undefined, commandId),
          resetProvider: () => { this.circuit.reset(); this.log('the provider circuit was reset from the UI'); },
          log: (m) => this.log(m),
        },
      });
      await this.ui.start();
    }
  }

  /** The UI's health line (protocol.md §12): who this is, and the link's state. */
  health(): Record<string, unknown> {
    return {
      device_id: this.config.deviceId, principal: this.config.principal, connection: this.linkState, epoch: this.link?.epoch ?? null,
      // D-116: the provider circuit (null when closed) and the day's spend on this device.
      provider_circuit: this.circuit.state(), spent_today_usd: this.spend.spent(), daily_budget_usd: this.config.agents.dailyBudgetUsd,
    };
  }

  journal(): Journal {
    this.journalInstance ??= new Journal(this.home, this.link?.epoch ?? 'none');
    return this.journalInstance;
  }

  /** A test-only crash at a named point (D-113): SIGKILL, so nothing after it runs, as in a real crash. */
  crashPoint(point: string): void {
    if (this.o.faults?.crashAt === point) {
      this.log(`fault injection: crashing at ${point}`);
      process.kill(process.pid, 'SIGKILL');
    }
  }

  /** Resolves once the server has welcomed this daemon and it has replayed each project's log. */
  async ready(): Promise<void> {
    if (!this.link) throw new Error('start() first');
    await this.link.whenReady();
    // The server decides how each project integrates (D-114): a config that disagrees would land work the wrong way.
    for (const p of this.config.projects) {
      const mode = this.link.modes[p.id] ?? 'local';
      if (mode !== p.integration) throw new Error(`${p.id}: config.toml says integration = "${p.integration}", but the coordinator says "${mode}"; fix the config (D-114)`);
    }
    await this.link.whenCaughtUp();
    await this.recovered;
    this.logTrustPostgres();
    this.recoverLands();
    void this.cleanLeftovers().catch((e: Error) => this.log(`cleaning up after the last run: ${e.message}`));
    this.leases.start();
    const github = () => this.config.projects.filter((p) => p.integration === 'github');
    if (github().length && !this.poller) {
      this.poller = new Poller({
        projects: github, view: (id) => this.view(id), deviceId: this.config.deviceId, github: (p) => this.github(p),
        send: async (projectId, name, args) => (await this.link!.command(projectId, name, args)).result,
        advanceBase: async (p, tip) => { await advanceBaseRef(p.repo, p.id, tip); },
        log: (m) => this.log(m), ...(this.o.pollMs ? { intervalMs: this.o.pollMs } : {}),
      });
      this.poller.start();
    }
  }

  /** The UI's read model of one project (D-117): its view, plus this harnessd's approvals, publishing, link and budget. */
  snapshot(projectId: string): ProjectSnapshot {
    const project = this.project(projectId);
    const view = this.view(projectId);
    const j = this.journal();
    // Committed for publishing, with no PR and no "nothing to publish" yet: the push and the PR are under way (D-114).
    const publishing = new Set([...view.tasks.values()]
      .filter((t) => t.status === 'done' && j.has(projectId, t.id, 'committed') && !j.has(projectId, t.id, 'pr') && !j.has(projectId, t.id, 'no_change'))
      .map((t) => t.id));
    return snapshotOf(view, {
      deviceId: this.config.deviceId, principal: this.config.principal, integrationMode: project.integration, connection: this.linkState,
      approvals: this.approvals.pending().filter((r) => r.projectId === projectId).map((r) => ({ taskId: r.taskId, kind: r.kind ?? 'setup' })),
      publishing, budget: { dailyBudgetUsd: this.config.agents.dailyBudgetUsd, sessionCapUsd: this.config.agents.maxBudgetUsd, spentUsd: this.spend.spent() },
    });
  }

  view(projectId: string): ProjectView {
    const v = this.views.get(projectId);
    if (!v) throw new Error(`project ${projectId} is not in ${this.home.config}`);
    return v;
  }

  /** Every event is folded into the project's view; only new ones are acted on (D-78). */
  onEvent(e: EventMessage, replayed: boolean): void {
    this.views.get(e.project_id)?.apply(e);
    if (replayed) return;
    this.o.onEvent?.(e);
    if (LIFECYCLE.includes(e.kind)) {
      const taskId = (e.data as { task_id: string }).task_id;
      // The receipt is durable before this returns, so before the link saves the cursor past it (D-113, link.ts).
      if (this.isMine(e.project_id, taskId)) {
        this.journal().append(e.project_id, taskId, 'received', { seq: e.seq, kind: e.kind });
        if (e.kind === 'task.assigned') this.crashPoint('after_assignment_receipt');
      }
      if (this.recovering) {
        this.buffered.set(taskId, [...(this.buffered.get(taskId) ?? []), e]);
      } else {
        this.chain(taskId, () => this.lifecycle(e), e.kind);
      }
    }
    if (e.kind === 'message.sent') {
      const m = this.view(e.project_id).messages.get((e.data as { message_id: string }).message_id);
      // A message for a task goes to that task's run; an agent may still be winding down its previous one.
      const run = m?.to ? [...this.running.values()].find((r) => r.projectId === e.project_id && r.agent.id === m.to && (!m.toTask || r.taskId === m.toTask)) : undefined;
      if (m && run) void this.deliver(run, m);
    }
    if (e.kind === 'message.superseded') {
      // A notice still in the agent's queue is old news when the newer one is about the same writer's change
      // (in progress, or landed). Another writer's notice doesn't tell it, so that one still goes (D-99).
      const d = e.data as { message_id: string; by?: string; to_task_id?: string };
      const run = d.to_task_id ? this.running.get(d.to_task_id) : undefined;
      const messages = this.views.get(e.project_id)?.messages;
      const writer = messages?.get(d.message_id)?.data.writer_task;
      if (run && run.projectId === e.project_id && typeof writer === 'string' && d.by && messages?.get(d.by)?.data.writer_task === writer) {
        run.adapter.withdrawNotice(run.handle, d.message_id);
      }
    }
    if (e.kind === 'wait.resolved' || e.kind === 'wait.timed_out') {
      const w = this.view(e.project_id).waits.get((e.data as { wait_id: string }).wait_id);
      const run = w ? this.running.get(w.taskId) : undefined;
      if (w && run && run.projectId === e.project_id && run.sessionId === w.sessionId) void this.deliverWait(run, w);
    }
    if (e.kind === 'land.requested' && (e.data as { device_id?: string }).device_id === this.config.deviceId) {
      const d = e.data as { land_id: string; task_id: string; run_tests?: boolean; mode?: string };
      // A GitHub project's land is the integration reservation (D-115); the local land never runs there.
      if (d.mode === 'github') this.queueLand(e.project_id, () => integrateRemote(this, e.project_id, d.land_id));
      else if (this.project(e.project_id).integration === 'local') this.queueLand(e.project_id, () => this.land(e.project_id, d.land_id, d.task_id, d.run_tests !== false));
      else void this.report(e.project_id, 'land.fail', { land_id: d.land_id, reason: 'error', detail: 'this project integrates through GitHub' }).catch(() => {});
    }
    if (e.kind === 'task.unblocked') {
      const run = this.running.get((e.data as { task_id: string }).task_id);
      if (run?.sync.blocked) void this.resumeAfterConflict(run);
    }
  }

  /** Runs `job` after the task's earlier lifecycle work, one at a time per task. */
  chain(taskId: string, job: () => Promise<void>, what: string): void {
    const next: Promise<void> = (this.lifecycles.get(taskId) ?? Promise.resolve())
      .then(job)
      .catch((err: Error) => this.log(`${what} ${taskId}: ${err.message}`))
      .finally(() => { if (this.lifecycles.get(taskId) === next) this.lifecycles.delete(taskId); });
    this.lifecycles.set(taskId, next);
  }

  /** A task whose agent is accountable to this daemon's human (D-112 narrows this to the agent's own device). */
  isMine(projectId: string, taskId: string): boolean {
    const view = this.views.get(projectId);
    const task = view?.tasks.get(taskId);
    const agent = task?.assignee ? view!.agents.get(task.assignee) : undefined;
    return !!agent && agent.humanId === this.config.principal;
  }

  /**
   * Startup recovery (D-113). Runs once the logs are caught up, before any lifecycle event that arrived meanwhile:
   * 1. every session the server still shows live on this device, but that isn't running here, is reported ended;
   * 2. each of this human's tasks is reconciled from its journal and its worktree, in its lifecycle chain;
   * 3. then the buffered events run, in order.
   * Nothing here ever starts an agent on a task that has run before: an interrupted task is `stopped`, and its
   * human resumes it (task.resume).
   */
  async recover(): Promise<void> {
    const mine = new Set(this.config.projects.filter((p) => (this.link!.modes[p.id] ?? 'local') === p.integration).map((p) => p.id));
    const running = new Set([...this.running.values()].map((r) => r.sessionId));
    for (const p of this.config.projects) {
      if (!mine.has(p.id)) continue;
      for (const s of this.view(p.id).sessions.values()) {
        if (s.deviceId !== this.config.deviceId || s.status === 'ended' || running.has(s.id)) continue;
        await this.report(p.id, 'session.report', { session_id: s.id, status: 'ended', reason: 'harnessd_restarted' }, s.agentId)
          .catch((e: Error) => { if (!/has ended/.test(e.message)) this.log(`session ${s.id}: couldn't report it ended: ${e.message}`); });
        this.sessions.markEnded(s.id, 'harnessd_restarted');
      }
    }
    const tasks = new Map<string, string>(); // task → project
    for (const [projectId, taskId] of this.journal().tasks()) if (mine.has(projectId)) tasks.set(taskId, projectId);
    for (const p of this.config.projects) {
      if (!mine.has(p.id)) continue;
      for (const t of this.view(p.id).tasks.values()) if (this.isMine(p.id, t.id) && ['in_progress', 'blocked', 'done', 'abandoned'].includes(t.status)) tasks.set(t.id, p.id);
    }
    for (const [taskId, projectId] of tasks) this.chain(taskId, () => this.recoverTask(projectId, taskId), 'recovery of');
    this.recovering = false;
    for (const [taskId, events] of this.buffered) for (const e of events) this.chain(taskId, () => this.lifecycle(e), e.kind);
    this.buffered.clear();
  }

  /** One task after a restart: see recover(). */
  async recoverTask(projectId: string, taskId: string): Promise<void> {
    const view = this.view(projectId);
    const task = view.tasks.get(taskId);
    if (!task || !this.isMine(projectId, taskId) || this.running.has(taskId)) return;
    const j = this.journal();
    const worktree = this.worktreeOf(projectId, taskId);
    const hasWorktree = fs.existsSync(worktree);
    const ranBefore = [...view.sessions.values()].some((s) => s.taskId === taskId);
    if (task.status === 'in_progress' || task.status === 'blocked') {
      if (!hasWorktree && !ranBefore && task.status === 'in_progress') {
        // Assigned, never started: the crash came between the receipt and the worktree. Do what was asked.
        this.log(`${taskId}: assigned but never started; starting it now`);
        return this.lifecycle(synthetic(projectId, 'task.assigned', taskId));
      }
      if (!hasWorktree) {
        j.append(projectId, taskId, 'stopped', { reason: 'worktree_missing' });
        this.log(`${taskId}: it ran before, but its worktree isn't on this device; it stays stopped`);
        return;
      }
      const setupIncomplete = j.has(projectId, taskId, 'setup_started') && !j.has(projectId, taskId, 'setup_ok');
      j.append(projectId, taskId, 'stopped', { reason: setupIncomplete ? 'setup_incomplete' : 'harnessd_restarted' });
      this.log(`${taskId}: its session was interrupted; its work stays in ${worktree}. Resume it with: harness task resume ${taskId}`);
      return;
    }
    if (task.status === 'done' && hasWorktree && !j.has(projectId, taskId, 'committed')) {
      // Completed, but the crash came before the commit: commit now, as the completion would have.
      const agent = view.agents.get(task.assignee!)!;
      const commit = await this.finishTask({ projectId, taskId, agent: { id: agent.id, name: agent.name }, ...(task.summary ? { summary: task.summary } : {}) });
      j.append(projectId, taskId, 'committed', { sha: commit });
      this.ports.release(taskId);
      if (commit) await this.report(projectId, 'worktree.report', { task_id: taskId, event: 'committed', path: worktree, branch: taskBranch(taskId), commit });
      this.log(`${taskId}: recovered its completion: ${commit ? `committed ${commit.slice(0, 12)}` : 'nothing to commit'}`);
    }
    if (task.status === 'done' && hasWorktree && this.project(projectId).integration === 'github' && !j.has(projectId, taskId, 'pr') && !j.has(projectId, taskId, 'no_change')) {
      // Committed, not yet published (or published before the crash, without the record): publish, idempotently.
      return this.publishTask(projectId, taskId);
    }
    if (task.status === 'done') return;
    if (task.status === 'abandoned' && hasWorktree) {
      await this.teardownTask({ projectId, taskId }, { force: true });
      j.append(projectId, taskId, 'abandoned');
    }
  }

  /**
   * The task lifecycle on this device (D-54), for agents accountable to this daemon's human:
   * - assigned: create the worktree from the base branch's tip, run setup, start the agent;
   * - reopened: start the agent again in the task's worktree, on its branch, with its human's message (D-107);
   * - resumed: start a new session in a stopped task's preserved worktree, with a handoff (D-113);
   * - completed: let the agent finish its turn, stop it, commit its work, free its ports (the worktree
   *   and branch stay for review; land is 0B);
   * - abandoned: stop the agent and remove the worktree.
   */
  async lifecycle(e: EventMessage): Promise<void> {
    const view = this.view(e.project_id);
    const taskId = (e.data as { task_id: string }).task_id;
    const task = view.tasks.get(taskId);
    if (!task?.assignee) return;
    const agent = view.agents.get(task.assignee);
    if (!agent || agent.humanId !== this.config.principal) return; // another human's agent runs on their device
    const project = this.project(e.project_id);
    const ref: AgentRef = { id: agent.id, name: agent.name, vendor: agent.vendor };
    // D-119: refused before a worktree, setup or ports exist; startAgent checks again (cached).
    if (e.kind === 'task.assigned' || e.kind === 'task.reopened') {
      await this.refuseIfTrustPostgres();
      this.refuseIfNoBudget(); // D-116: before a worktree, setup or ports exist
    }
    if (e.kind === 'task.assigned') {
      if (!this.adapters[agent.vendor]) throw new Error(`no adapter for ${agent.vendor} on this device`);
      if (this.running.has(taskId)) return; // already running here: a replayed or duplicate assignment starts nothing
      // T-5 (D-118): a task another human wrote is screened like a peer's message, before anything is prepared.
      if (task.ownerHumanId !== this.config.principal && !(await this.taskScreenedOk(project.id, taskId, `${task.title}\n${task.text}`, task.ownerHumanId))) return;
      // A GitHub project's tasks start from the base as the remote has it, fetched and verified (D-114).
      const baseSha = project.integration === 'github' ? await this.fetchProjectBase(project) : await branchTip(project.repo, project.baseBranch);
      const ws = await this.prepareTask({ projectId: project.id, taskId, baseSha, agentId: agent.id });
      if (this.stopping) return;
      await this.startAgent(ws, ref, { id: task.id, title: task.title, text: task.text, scope: task.scope, ownerHumanId: task.ownerHumanId });
      this.log(`${agent.name} started on ${taskId} in ${ws.worktree}`);
    } else if (e.kind === 'task.reopened') {
      if (!this.adapters[agent.vendor]) throw new Error(`no adapter for ${agent.vendor} on this device`);
      if (!fs.existsSync(this.worktreeOf(project.id, taskId))) throw new Error(`${taskId}'s worktree isn't on this device; it can't be reopened here`);
      const ws = await this.prepareTask({ projectId: project.id, taskId, baseSha: '', agentId: agent.id, reuse: true });
      if (this.stopping) return;
      const message = String((e.data as { text?: unknown }).text ?? '');
      await this.startAgent(ws, ref, { id: task.id, title: task.title, text: reopenedText(task.text, message), scope: task.scope, ownerHumanId: task.ownerHumanId });
      this.log(`${agent.name} started again on ${taskId} (reopened) in ${ws.worktree}`);
    } else if (e.kind === 'task.resumed') {
      if (!this.adapters[agent.vendor]) throw new Error(`no adapter for ${agent.vendor} on this device`);
      if (this.running.has(taskId)) return;
      if (!fs.existsSync(this.worktreeOf(project.id, taskId))) throw new Error(`${taskId}'s worktree isn't on this device; it can't be resumed here`);
      const j = this.journal();
      // A crash during setup: run the approved setup again before the session (same hash, no new approval).
      const forceSetup = j.has(project.id, taskId, 'setup_started') && !j.has(project.id, taskId, 'setup_ok');
      const ws = await this.prepareTask({ projectId: project.id, taskId, baseSha: '', agentId: agent.id, reuse: true, forceSetup });
      if (this.stopping) return;
      const diffStat = await git(ws.worktree, 'diff', '--stat', 'HEAD').catch(() => '');
      const message = String((e.data as { text?: unknown }).text ?? '');
      await this.startAgent(ws, ref, { id: task.id, title: task.title, text: resumedText(task.text, message, diffStat), scope: task.scope, ownerHumanId: task.ownerHumanId });
      this.log(`${agent.name} resumed ${taskId} in ${ws.worktree}`);
    } else if (e.kind === 'task.completed') {
      const run = this.running.get(taskId);
      if (run) {
        await this.untilIdle(run, this.o.finishGraceMs ?? 60_000);
        await this.stopAgent(taskId);
      }
      const worktree = this.worktreeOf(project.id, taskId);
      if (!fs.existsSync(worktree)) return;
      this.crashPoint('after_report_done');
      const commit = await this.finishTask({ projectId: project.id, taskId, agent: ref, ...(task.summary ? { summary: task.summary } : {}) });
      this.journal().append(project.id, taskId, 'committed', { sha: commit });
      this.ports.release(taskId);
      if (commit) await this.report(project.id, 'worktree.report', { task_id: taskId, event: 'committed', path: worktree, branch: `harness/task/${taskId}`, commit });
      this.log(`${taskId} done: ${commit ? `committed ${commit.slice(0, 12)} on harness/task/${taskId}` : 'nothing to commit'}`);
      if (project.integration === 'github') await this.publishTask(project.id, taskId);
    } else {
      if (this.running.has(taskId)) await this.stopAgent(taskId, 'kill');
      this.leases.untrack(taskId);
      if (fs.existsSync(this.worktreeOf(project.id, taskId))) await this.teardownTask({ projectId: project.id, taskId }, { force: true });
      this.journal().append(project.id, taskId, 'abandoned');
      this.log(`${taskId} abandoned; its worktree is removed`);
    }
  }

  /** Waits until the agent's turn has ended (D-67), or `ms` passes. */
  async untilIdle(run: RunningAgent, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && this.running.get(run.taskId) === run) {
      const st = run.adapter.getStatus(run.handle);
      if (st !== 'working' && st !== 'starting') return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * The T-5 screen for one message (D-118): true when it may be delivered (nothing matched, or its human released it).
   * Otherwise it's held: a `security_review` request names the rules, the sender and the exact text, and a watcher
   * delivers it once released. A denied one is never delivered.
   */
  async screenedOk(run: RunningAgent, m: MessageInfo, from: string): Promise<boolean> {
    const hits = screenText(m.text);
    if (!hits.length) return true;
    const hash = reviewHash(m.id, m.text);
    if (this.approvals.isApproved(run.projectId, hash)) return true;
    if (this.screenDenied.has(m.id)) return false;
    const req = this.approvals.request({
      projectId: run.projectId, taskId: run.taskId, manifests: [], hash, kind: 'security_review',
      command: `a message from ${from} to ${run.agent.name} (${run.taskId}) asks to ${hits.map((h) => h.rule).join(', ')}; it's held until you release it. The exact text:\n${m.text}`,
    });
    if (!this.reviewing.has(m.id)) {
      this.reviewing.add(m.id);
      this.log(`held message ${m.id} from ${from} for ${run.agent.name}: ${hits.map((h) => `${h.rule} ("${h.excerpt}")`).join('; ')}. Review it with: harness approve ${req.id}`);
      void this.awaitReview(run, m, hash, req.id).finally(() => this.reviewing.delete(m.id));
    }
    return false;
  }

  /** The screen for a task's text when another human wrote it (D-118): waits for the review; false when it's denied or unanswered. */
  async taskScreenedOk(projectId: string, taskId: string, text: string, owner: string): Promise<boolean> {
    const hits = screenText(text);
    if (!hits.length) return true;
    const hash = reviewHash(`task:${taskId}`, text);
    if (this.approvals.isApproved(projectId, hash)) return true;
    const req = this.approvals.request({
      projectId, taskId, manifests: [], hash, kind: 'security_review',
      command: `task ${taskId}, written by ${owner}, asks to ${hits.map((h) => h.rule).join(', ')}; your agent starts it only once you release it. The exact text:\n${text}`,
    });
    this.log(`held task ${taskId} from ${owner}: ${hits.map((h) => `${h.rule} ("${h.excerpt}")`).join('; ')}. Review it with: harness approve ${req.id}`);
    const deadline = Date.now() + (this.o.approvalTimeoutMs ?? 30 * 60_000);
    while (!this.stopping && Date.now() < deadline) {
      if (this.approvals.isApproved(projectId, hash)) return true;
      if (!this.approvals.pending().some((r) => r.id === req.id && r.projectId === projectId)) {
        this.log(`${taskId}: not started; its human denied the review`);
        return false;
      }
      await new Promise((r) => setTimeout(r, this.o.approvalPollMs ?? 500));
    }
    this.log(`${taskId}: not started; nobody released it`);
    return false;
  }

  async awaitReview(run: RunningAgent, m: MessageInfo, hash: string, id: string): Promise<void> {
    while (this.running.get(run.taskId) === run && !this.stopping) {
      if (this.approvals.isApproved(run.projectId, hash)) {
        this.log(`message ${m.id}: released by its human; delivering it to ${run.agent.name}`);
        return this.deliver(run, m);
      }
      if (!this.approvals.pending().some((r) => r.id === id && r.projectId === run.projectId)) {
        this.screenDenied.add(m.id);
        this.log(`message ${m.id} to ${run.agent.name}: not delivered; its human denied it`);
        return;
      }
      await new Promise((r) => setTimeout(r, this.o.approvalPollMs ?? 500));
    }
  }

  /**
   * Injects a message into the recipient's live session at its next safe boundary (D-26), rendered in
   * its envelope (D-25), then acknowledges where it landed. A high-priority harness notice goes to the
   * adapter's notice queue instead (D-99). Held (over-budget) messages are never delivered. Messages for
   * an agent with no live session wait in the log until its session starts.
   */
  async deliver(run: RunningAgent, m: MessageInfo): Promise<void> {
    if (m.held || m.deliveredAt || m.supersededBy || this.delivering.has(m.id) || this.delivered.has(m.id)) return;
    if (m.toTask && m.toTask !== run.taskId) return; // news for an earlier task never reaches a later one
    // A landed change is told only after this branch has it: held for the sync at turn end (D-53).
    if (m.kind === 'dependency_changed' && m.data.stage === 'landed') return this.holdForSync(run, m);
    await run.sync.running; // nothing is injected while the branch is being synced (D-28, D-53)
    if (run.sync.blocked) return; // paused on a conflict: delivered after the human unblocks it
    if (m.deliveredAt || m.supersededBy || this.delivering.has(m.id) || this.delivered.has(m.id)) return;
    this.delivering.add(m.id);
    try {
      const view = this.view(run.projectId);
      const sender = view.agents.get(m.from);
      const msg: MessageForAgent = {
        id: m.id, kind: m.kind, text: m.text, fromTask: m.fromTask, ...(m.inReplyTo ? { inReplyTo: m.inReplyTo } : {}),
        ...(Array.isArray(m.data.about_paths) ? { aboutPaths: m.data.about_paths as string[] } : {}),
        ...(m.kind === 'claim_conflict' && m.data.level === 'lease' ? { lease: true } : {}),
        sender: m.from === 'harness' ? { kind: 'harness' }
          : sender ? { kind: 'agent', name: sender.name, humanId: sender.humanId }
          : { kind: 'human', id: m.from, local: m.from === this.config.principal },
      };
      const text = renderMessage(msg);
      const origin = msg.sender.kind === 'harness' ? 'coordinator' : msg.sender.kind === 'human' && msg.sender.local ? 'human' : 'peer';
      // T-5 (D-118): a peer's or another human's ask to disable checks, read or send outside the task, or widen its
      // scope waits for this human's review; released, it's delivered verbatim (D-63).
      if (origin === 'peer' && !(await this.screenedOk(run, m, msg.sender.kind === 'agent' ? msg.sender.name : m.from))) return;
      // The harness's own high-priority notices ride the agent's next tool results (D-99); everything else is injected.
      const notice = msg.sender.kind === 'harness' && m.priority === 'high';
      const receipt = await (notice ? run.adapter.queueNotice(run.handle, { id: m.id, text, origin }) : run.adapter.injectMessage(run.handle, { id: m.id, text, origin }));
      this.delivered.add(m.id);
      await this.report(run.projectId, 'message.ack', {
        message_id: m.id, delivered_at: new Date(receipt.deliveredAt).toISOString(), delivery: receipt.landed, est_tokens: Math.ceil(text.length / 4),
      }, run.agent.id);
    } catch (e) {
      this.log(`message ${m.id} to ${run.agent.name}: not delivered: ${(e as Error).message}`);
    } finally {
      this.delivering.delete(m.id);
    }
  }

  /**
   * File names with control, format or line-separator characters are never reported: they'd end up in other
   * agents' notices, where one could forge a line (D-25, D-99). They're logged for the human instead.
   */
  reportablePaths(run: RunningAgent, paths: string[]): string[] {
    const bad = paths.filter((p) => UNSAFE_NAME.test(p));
    if (bad.length) this.log(`${run.agent.name} (${run.taskId}): not reporting ${bad.length} file name(s) with control characters: ${JSON.stringify(bad)}`);
    return paths.filter((p) => !bad.includes(p));
  }

  /**
   * A settled wait's outcome, pushed to the agent that waited (D-95, D-101). It's a high-priority notice: it
   * opens a new turn if the agent ended its turn as asked, and the Stop gate keeps the turn going if it hasn't
   * yet (D-100). Like any delivery, never during a sync, and held while the task is paused on a conflict.
   */
  async deliverWait(run: RunningAgent, w: WaitInfo): Promise<void> {
    const id = `wait:${w.id}`;
    if (this.delivering.has(id) || this.delivered.has(id)) return;
    // Resolved by wait.start itself: the tool's result already said so. The server marks it, because the two
    // events' times can differ, even across a millisecond (#70).
    if (w.outcome === 'resolved' && w.immediate) return;
    await run.sync.running;
    if (run.sync.blocked || this.delivering.has(id) || this.delivered.has(id)) return; // delivered after the unblock (deliverPending)
    const text = renderMessage({ id, kind: 'wait_outcome', text: waitOutcomeText(w), fromTask: null, sender: { kind: 'harness' } });
    // A wait for another task's land is over only once this branch has that land (D-106): merge it, then tell.
    if (w.outcome === 'resolved' && w.on.kind === 'task' && w.result?.status === 'landed' && !(await this.hasLand(run, w.on.id))) return this.syncThenTell(run, id, text, `task ${w.on.id}'s land`);
    this.delivering.add(id);
    try {
      await run.adapter.queueNotice(run.handle, { id, text, origin: 'coordinator' });
      this.delivered.add(id);
    } catch (e) {
      this.log(`wait ${w.id} outcome to ${run.agent.name}: not delivered: ${(e as Error).message}`);
    } finally {
      this.delivering.delete(id);
    }
  }

  /** Messages that arrived while the agent had no live session, or while it was paused, and waits that settled meanwhile. */
  deliverPending(run: RunningAgent): void {
    const view = this.view(run.projectId);
    const pending = [...view.messages.values()]
      .filter((m) => m.to === run.agent.id && (!m.toTask || m.toTask === run.taskId) && !m.held && !m.deliveredAt && !m.supersededBy)
      .sort((a, b) => a.seq - b.seq);
    for (const m of pending) void this.deliver(run, m);
    for (const w of view.waits.values()) {
      if (w.sessionId === run.sessionId && (w.outcome === 'resolved' || w.outcome === 'timed_out')) void this.deliverWait(run, w);
    }
  }

  // ---------- the land step (0B item 5; D-51, D-54; local-runtime.md §4) ----------

  /** Lands run one at a time per project. Once harnessd is stopping, one not started yet stays as it is on the server: recoverLands runs it at the next start. */
  queueLand(projectId: string, job: () => Promise<void>): void {
    const run = async () => {
      if (this.stopping) return;
      this.landsInFlight++;
      try { await job(); } finally { this.landsInFlight--; }
    };
    const next = (this.landing.get(projectId) ?? Promise.resolve()).then(run).catch((e: Error) => this.log(`land: ${e.message}`));
    this.landing.set(projectId, next);
  }

  landFile(landId: string): string {
    return path.join(this.home.root, 'lands', `${landId}.json`);
  }

  /**
   * Lands a finished task (D-51): sends what it will merge for the fencing check; merges the task's commit
   * into the base tip in an integration worktree; runs the approved setup and test commands there under
   * srt (tests may use local ports, nothing else on the network, D-83); then moves the base branch, only
   * if green and only by compare-and-swap or a fast-forward of a clean checkout. Reports each step.
   */
  async land(projectId: string, landId: string, taskId: string, runTests: boolean): Promise<void> {
    const project = this.project(projectId);
    const fail = (reason: string, detail?: string, conflicts?: string[]) => this.report(projectId, 'land.fail', {
      land_id: landId, reason, ...(detail ? { detail: detail.slice(-1000) } : {}), ...(conflicts?.length ? { conflict_paths: conflicts } : {}),
    });
    const step = (s: string, detail?: string) => this.report(projectId, 'land.report', { land_id: landId, step: s, ...(detail ? { detail } : {}) });
    let head: string;
    let baseSha: string;
    let changed: string[];
    try {
      // The task's completion (stop the agent, commit its work) must be finished, or the land would take an older tip.
      await this.lifecycles.get(taskId);
      if (this.running.has(taskId)) throw new Error(`${taskId}'s agent is still running`);
      const taskWt = this.worktreeOf(projectId, taskId);
      if (fs.existsSync(taskWt) && await git(taskWt, 'status', '--porcelain')) {
        throw new Error(`${taskWt} has uncommitted changes that the land wouldn't include; commit or remove them, then land again`);
      }
      head = await branchTip(project.repo, taskBranch(taskId));
      baseSha = await branchTip(project.repo, project.baseBranch);
      const mergeBase = await git(project.repo, 'merge-base', baseSha, head);
      changed = await changedBetween(project.repo, mergeBase, head);
      if (changed.length > MAX_REPORT_PATHS) throw new Error(`the task changes ${changed.length} files; one land takes at most ${MAX_REPORT_PATHS}`);
      const r = await this.link!.command(projectId, 'land', {
        land_id: landId, base_branch: project.baseBranch, base_sha: baseSha, merge_base_sha: mergeBase, head_sha: head,
        changed_paths: changed.filter((p) => !/[\u0000-\u001f\u007f]/.test(p)), lease_tokens: this.leases.tokens(projectId, taskId),
      });
      if (!(r.result as { accepted?: boolean } | null)?.accepted) {
        this.log(`land of ${taskId} rejected by the fencing check: ${JSON.stringify((r.result as { problems?: unknown }).problems)}`);
        return;
      }
    } catch (e) {
      await fail('error', (e as Error).message).catch(() => {});
      return;
    }
    const dir = path.join(this.home.root, 'integration', projectId, landId);
    writeJsonAtomic(this.landFile(landId), { projectId, landId, taskId, baseSha, head, dir, merge: null });
    let moved = false;
    try {
      await addIntegrationWorktree(project.repo, dir, baseSha);
      const title = this.view(projectId).tasks.get(taskId)?.title ?? taskId;
      const m = await mergeCommit(dir, head, `Land ${taskId}: ${title}\n\nHarness-Land: ${landId}\nHarness-Task: ${taskId}`);
      if (!m.ok) return void await fail('conflict', `merging ${taskId} into ${project.baseBranch} conflicts`, m.conflicts);
      await step('merged');
      if (runTests) {
        const repo = readRepoConfig(dir);
        if (!repo.test) return void await fail('not_approved', `harness.yaml has no test.command; land with --no-tests to skip tests`);
        if (repo.setup) {
          await step('setup');
          await this.runApprovedSetup(project, taskId, dir, repo.setup, `land-${landId}`);
        }
        const { hash, manifests } = testHash(dir, repo.test.command, repo.test.manifests);
        if (!this.approvals.isApproved(project.id, hash)) {
          const req = this.approvals.request({ projectId: project.id, taskId, command: repo.test.command, manifests, hash, kind: 'test' });
          this.log(`the test command for landing ${taskId} needs your approval. Review it with: harness approve ${req.id}`);
          await step('awaiting_approval', `harness approve ${req.id}`);
          await this.waitForApproval(project.id, hash);
        }
        // D-119: the repo's test code runs with loopback access, like an agent's.
        await this.refuseIfTrustPostgres();
        await step('testing');
        const logFile = path.join(this.home.logs, `land-${landId}.log`);
        const timeout = Math.min(repo.test.timeoutSeconds ?? this.config.setup.timeoutSeconds, this.config.setup.timeoutSeconds);
        const result = await runSetup({
          home: this.home, worktree: dir, gitCommonDir: await gitCommonDir(project.repo), scratch: path.join(this.home.scratch, project.id, `land-${landId}`),
          command: repo.test.command, allowedDomains: [], allowLocalBinding: true, timeoutMs: timeout * 1000, logFile, signal: this.stopSignal.signal,
          onSpawn: (pgid) => this.recordProcs(`${project.id}-land-${landId}`, pgid),
        }).finally(() => this.forgetProcs(`${project.id}-land-${landId}`));
        if (result.aborted || this.stopping) throw new Error('harnessd stopped during the tests');
        if (result.exitCode !== 0) {
          const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n') : '';
          return void await fail('tests', `${result.timedOut ? 'timed out' : `exit ${result.exitCode}`}\n${tail}`);
        }
        await step('tested');
      }
      // The base never moves once harnessd is stopping: the land is interrupted, as a restart would interrupt it.
      if (this.stopping) throw new Error('harnessd stopped before the base moved');
      writeJsonAtomic(this.landFile(landId), { projectId, landId, taskId, baseSha, head, dir, merge: m.commit });
      const adv = await advanceBase(project.repo, project.baseBranch, baseSha, m.commit);
      if (!adv.ok) return void await fail(adv.reason, adv.detail);
      moved = true;
      await this.completeLand(projectId, landId, taskId, baseSha, m.commit, head);
      moved = false; // the server heard: the land's record goes too, as after a retry that got through
    } catch (e) {
      // Once the base has moved, the land happened: never report it failed. The record stays for a retry
      // now and for recovery at the next start. Before then, a stop interrupts it, as a restart does (recoverLands).
      if (!moved) await fail(e instanceof ApprovalTimeout ? 'not_approved' : this.stopping ? 'interrupted' : 'error', (e as Error).message).catch(() => {});
      else {
        this.log(`land of ${taskId}: the base moved, but reporting it failed (${(e as Error).message}); retrying`);
        const saved = readJson<{ merge: string | null } | null>(this.landFile(landId), null);
        for (let i = 1; i <= 3 && saved?.merge && !this.link?.stopped; i++) {
          await new Promise((r) => setTimeout(r, 1000 * i));
          try { await this.completeLand(projectId, landId, taskId, baseSha, saved.merge, head); moved = false; break; } catch { /* retried at the next start */ }
        }
      }
    } finally {
      await removeIntegrationWorktree(project.repo, dir).catch(() => {});
      fs.rmSync(path.join(this.home.scratch, project.id, `land-${landId}`), { recursive: true, force: true });
      if (!moved) fs.rmSync(this.landFile(landId), { force: true }); // kept if the base moved and the server hasn't heard yet
    }
  }

  /** The base has moved: tell the server what changed (with blob ids, for landed notices), then retire the task's worktree. */
  async completeLand(projectId: string, landId: string, taskId: string, baseSha: string, merge: string, head: string): Promise<void> {
    const project = this.project(projectId);
    const changed = await changedBetween(project.repo, baseSha, merge);
    const blobs = await blobsAt(project.repo, merge, changed);
    await this.report(projectId, 'land.complete', {
      land_id: landId, old_base_sha: baseSha, new_base_sha: merge,
      changed: changed.filter((p) => !UNSAFE_NAME.test(p)).map((p) => ({ path: p, new_hash: blobs.get(p) ?? null })),
    });
    this.log(`landed ${taskId}: ${project.baseBranch} is now ${merge.slice(0, 12)}`);
    this.leases.untrack(taskId);
    // The landed task's worktree and branch go, unless something was written or committed there since the
    // land read its tip: never destroy work. The removal itself isn't forced, so Git refuses on any doubt.
    const taskWt = this.worktreeOf(projectId, taskId);
    const tip = await branchTip(project.repo, taskBranch(taskId)).catch(() => null);
    if (tip && tip !== head) this.log(`kept ${taskWt} and its branch: it has commits made after the land`);
    else if (fs.existsSync(taskWt) && !this.running.has(taskId)) {
      if (await git(taskWt, 'status', '--porcelain', '--untracked-files=all')) this.log(`kept ${taskWt}: it has changes made after the land`);
      else await this.teardownTask({ projectId, taskId }, { force: false }).catch((e) => this.log(`kept ${taskWt}: ${(e as Error).message.split('\n')[0]}`));
    }
    // Only if the base, as it is now, contains the branch.
    const baseNow = await branchTip(project.repo, project.baseBranch).catch(() => null);
    if (baseNow) await deleteMergedBranch(project.repo, taskBranch(taskId), head, baseNow);
  }

  /** The setup or test command's process group, recorded before it's awaited (D-113): a crash can't orphan it unrecorded. */
  recordProcs(name: string, pgid: number): void {
    void processStart(pgid).then((start) => {
      if (start && this.procsRunning.has(name)) writeJsonAtomic(path.join(this.home.root, 'procs', `${name}.json`), { pgid, start });
    });
    this.procsRunning.add(name);
  }

  forgetProcs(name: string): void {
    this.procsRunning.delete(name);
    fs.rmSync(path.join(this.home.root, 'procs', `${name}.json`), { force: true });
  }

  /**
   * At start: a setup or test command a crash left running is killed, group and all, but only if its process is the
   * one recorded (the same pid with the same start time: pids get reused). Recovery then re-runs what it must (D-113).
   */
  async killSetupOrphans(): Promise<void> {
    const dir = path.join(this.home.root, 'procs');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
      const rec = readJson<{ pgid?: unknown; start?: unknown } | null>(path.join(dir, f), null);
      if (rec && Number.isSafeInteger(rec.pgid) && (rec.pgid as number) > 1 && typeof rec.start === 'string' && (await processStart(rec.pgid as number)) === rec.start) {
        try { process.kill(-(rec.pgid as number), 'SIGKILL'); } catch { /* gone in the meantime */ }
        this.log(`killed the process group ${String(rec.pgid)} a crash left running (${f.replace(/\.json$/, '')})`);
      }
      fs.rmSync(path.join(dir, f), { force: true });
    }
  }

  /**
   * What a kill left behind (#74): integration checkouts and land scratch that no land in flight owns, and a landed
   * task's worktree that a kill after the land kept. That worktree goes only under the never-destroy-work checks: it's
   * clean, nothing runs there, and its branch is already in the base (a local land) or is exactly the approved head (a
   * GitHub land's squash shares no ancestry with it).
   */
  async cleanLeftovers(): Promise<void> {
    for (const p of this.config.projects) {
      const view = this.view(p.id);
      const live = new Set([...view.lands.values()].filter((l) => l.status === 'requested' || l.status === 'accepted').map((l) => l.id));
      const kept = (landId: string) => live.has(landId) || fs.existsSync(this.landFile(landId));
      const integration = path.join(this.home.root, 'integration', p.id);
      for (const id of fs.existsSync(integration) ? fs.readdirSync(integration) : []) {
        if (kept(id)) continue;
        await removeIntegrationWorktree(p.repo, path.join(integration, id)).catch(() => {});
        fs.rmSync(path.join(integration, id), { recursive: true, force: true });
        this.log(`removed ${path.join(integration, id)}, left by a land that isn't running`);
      }
      const scratch = path.join(this.home.scratch, p.id);
      for (const d of fs.existsSync(scratch) ? fs.readdirSync(scratch).filter((x) => x.startsWith('land-')) : []) {
        if (!kept(d.slice('land-'.length))) fs.rmSync(path.join(scratch, d), { recursive: true, force: true });
      }
      const base = p.integration === 'github' ? null : await branchTip(p.repo, p.baseBranch).catch(() => null);
      for (const l of view.lands.values()) {
        if (l.status !== 'completed' || l.deviceId !== this.config.deviceId || l.mode === 'external') continue;
        const wt = this.worktreeOf(p.id, l.taskId);
        if (!fs.existsSync(wt) || this.running.has(l.taskId) || view.tasks.get(l.taskId)?.status !== 'landed') continue;
        const tip = await branchTip(p.repo, taskBranch(l.taskId)).catch(() => null);
        const merged = !!tip && (l.mode === 'github'
          ? tip === l.approvedHead
          : !!base && await git(p.repo, 'merge-base', '--is-ancestor', tip, base).then(() => true, () => false));
        if (!merged) { this.log(`kept ${wt}: its branch has commits the land didn't include`); continue; }
        if (await git(wt, 'status', '--porcelain', '--untracked-files=all').catch(() => 'unknown')) { this.log(`kept ${wt}: it has changes made after the land`); continue; }
        await this.teardownTask({ projectId: p.id, taskId: l.taskId }, { force: false }).catch((e: Error) => this.log(`kept ${wt}: ${e.message.split('\n')[0]}`));
        if (l.mode === 'github') await git(p.repo, 'update-ref', '-d', `refs/heads/${taskBranch(l.taskId)}`, tip!).catch(() => {});
      }
    }
  }

  /**
   * After a restart: lands this device was asked to run while it was away start now; one interrupted after
   * the base moved is completed (even if a human cancelled it meanwhile: the change is in the base); one
   * interrupted before is failed, with the base untouched.
   */
  recoverLands(): void {
    for (const p of this.config.projects) {
      for (const l of this.view(p.id).lands.values()) {
        if (l.deviceId !== this.config.deviceId) continue;
        if (l.mode === 'github') {
          // Resumed from its journal and GitHub's state (integrate-remote.ts), never by the local land's rules.
          if (l.status === 'requested' || l.status === 'accepted') this.queueLand(p.id, () => integrateRemote(this, p.id, l.id));
          continue;
        }
        if (l.mode === 'external') continue;
        if (l.status === 'requested') this.queueLand(p.id, () => this.land(p.id, l.id, l.taskId, l.runTests));
        const cancelled = l.status === 'failed' && l.reason === 'cancelled';
        if (l.status !== 'accepted' && !(cancelled && fs.existsSync(this.landFile(l.id)))) continue;
        this.queueLand(p.id, async () => {
          const saved = readJson<{ baseSha: string; head: string; dir: string; merge: string | null } | null>(this.landFile(l.id), null);
          const tip = await branchTip(p.repo, p.baseBranch).catch(() => '');
          // The base reached the land's merge if it contains it now (later commits may have come on top).
          const reached = !!(saved?.merge && tip && await git(p.repo, 'merge-base', '--is-ancestor', saved.merge, tip).then(() => true, () => false));
          if (saved?.merge && reached) {
            await this.completeLand(p.id, l.id, l.taskId, saved.baseSha, saved.merge, saved.head);
          } else if (!cancelled) {
            await this.report(p.id, 'land.fail', { land_id: l.id, reason: 'interrupted', detail: 'harnessd restarted before the base moved' });
          }
          if (saved) await removeIntegrationWorktree(p.repo, saved.dir).catch(() => {});
          fs.rmSync(this.landFile(l.id), { force: true });
        });
      }
    }
  }

  // ---------- sync at turn end (0B item 2; D-53; coordination.md §2) ----------

  /** Does this branch have task `taskId`'s land? With no completed land seen there's nothing to merge, so yes. */
  async hasLand(run: RunningAgent, taskId: string): Promise<boolean> {
    const land = [...this.view(run.projectId).lands.values()].find((l) => l.taskId === taskId && l.status === 'completed' && l.newBaseSha);
    return !land || contains(run.workspace.worktree, land.newBaseSha!);
  }

  /**
   * A land this agent is waiting for reaches it only once its branch has it (D-106): sync now if it's between
   * turns, else at its turn end (the Stop gate lets the turn end for it), and then tell it. The notice opens its
   * next turn.
   */
  syncThenTell(run: RunningAgent, id: string, text: string, label: string): void {
    if (this.delivered.has(id) || run.sync.after.some((a) => a.id === id)) return;
    run.sync.after.push({ id, text, label });
    run.sync.forced = true;
    run.sync.pending = true;
    if (!run.sync.running && !run.sync.blocked && this.betweenTurns(run)) void this.runSync(run);
  }

  /** What `report_done` must wait for (D-106): files a landed change touched, and lands this agent waits for, not yet merged into its branch. */
  landedNotMerged(taskId: string): string[] {
    const run = this.running.get(taskId);
    if (!run) return [];
    const paths = run.sync.held.filter((m) => !this.delivered.has(m.id)).flatMap((m) => (Array.isArray(m.data.paths) ? m.data.paths as string[] : []));
    return [...new Set([...paths, ...run.sync.after.filter((a) => !this.delivered.has(a.id)).map((a) => a.label)])];
  }

  /** Between turns: idle, or errored (the turn failed but the session is alive). A sync never starts mid-turn (D-28). */
  betweenTurns(run: RunningAgent): boolean {
    const st = run.adapter.getStatus(run.handle);
    return st === 'idle' || st === 'errored';
  }

  holdForSync(run: RunningAgent, m: MessageInfo): void {
    if (!run.sync.held.some((x) => x.id === m.id)) run.sync.held.push(m);
    run.sync.pending = true;
    if (!run.sync.running && !run.sync.blocked && this.betweenTurns(run)) void this.runSync(run); // idle: now
  }

  /**
   * Holds the agent, commits its work in progress, merges the base tip into its branch, reports the sync
   * (which marks the synced reads stale), and only then tells it what landed, with a diff excerpt. On a
   * conflict the merge is aborted, the task blocked, and the agent stays held until the human resolves it.
   * One sync at a time per run; Git never runs alongside the periodic worktree diff. `resume` is the sync
   * after `harness task unblock`, and `since` the merge base from before the conflict (for the diff and the
   * stale reads).
   */
  runSync(run: RunningAgent, opts: { resume?: boolean; since?: string } = {}): Promise<void> {
    if (run.sync.running) return run.sync.running;
    if (run.sync.blocked || (!run.sync.pending && !opts.resume)) return Promise.resolve();
    if (!this.betweenTurns(run)) return Promise.resolve(); // mid-turn: at its turn end (D-28)
    run.sync.pending = false;
    const forced = run.sync.forced === true; // a land the agent waits for, with no notice held (D-106)
    run.sync.forced = false;
    let held: MessageInfo[] = [];
    const job = (async () => {
      await run.diff.running; // never alongside a worktree diff: both use the index
      const view = this.view(run.projectId);
      held = run.sync.held.splice(0).map((m) => view.messages.get(m.id) ?? m).filter((m) => !m.deliveredAt && !m.supersededBy);
      if (!held.length && !opts.resume && !forced) return;
      const project = this.project(run.projectId);
      const worktree = run.workspace.worktree;
      run.adapter.setHold(run.handle, SYNC_HOLD);
      let release = true;
      try {
        // GitHub mode (D-114): the base as harnessd fetched it from the remote, never the human's local branch. A notice
        // naming a commit this base doesn't contain stays held (finishSync), so nothing named by the server is trusted.
        let target: string;
        if (project.integration === 'github') {
          try {
            target = await this.fetchProjectBase(project);
          } catch (e) {
            await this.report(run.projectId, 'sync.report', { session_id: run.sessionId, event: 'fetch_failed', reason: (e as Error).message.slice(0, 300) }, run.agent.id).catch(() => {});
            throw e;
          }
        } else {
          target = await branchTip(project.repo, project.baseBranch);
        }
        const blockOn = async (oldBase: string, conflicts: string[]) => {
          await this.report(run.projectId, 'sync.report', {
            session_id: run.sessionId, event: 'conflict', old_base_sha: oldBase, new_base_sha: target, conflict_paths: this.reportablePaths(run, conflicts).slice(0, MAX_REPORT_PATHS),
          }, run.agent.id);
          run.sync.blocked = { target, oldBase };
          run.sync.held.unshift(...held);
          held = [];
          run.adapter.setHold(run.handle, BLOCKED_HOLD);
          release = false;
          this.log(`${run.agent.name} (${run.taskId}): syncing with ${project.baseBranch} conflicts in ${conflicts.join(', ')}; the task is blocked until you resolve it in ${worktree} and run: harness task unblock ${run.taskId}`);
        };
        // A merge left unfinished in the worktree (after an unblock, or a human's own) is never committed as the agent's work.
        const left = await unresolved(worktree);
        if (left) return void await blockOn(opts.since ?? target, left);
        const r = await syncWorktree({
          worktree, target, taskId: run.taskId, agent: { name: run.agent.name, email: `${run.agent.id}@harness.invalid` },
          ...(project.commitIdentity ? { identity: project.commitIdentity } : {}),
        });
        if (!r.ok) return void await blockOn(opts.since ?? r.oldBase, r.conflicts);
        const since = opts.since ?? r.oldBase;
        const changed = since === r.oldBase ? r.changed : await changedBetween(worktree, since, r.newBase);
        await this.finishSync(run, held, since, r.newBase, changed);
        held = [];
        if (opts.resume) setImmediate(() => this.deliverPending(run)); // what arrived while it was paused
      } finally {
        if (release) run.adapter.setHold(run.handle, null);
      }
    })().catch((e: Error) => {
      // Nothing is lost: the notices go back, and the sync is tried again at the next turn end.
      run.sync.held.unshift(...held.filter((m) => !this.delivered.has(m.id)));
      if (!run.sync.blocked) run.adapter.setHold(run.handle, null);
      run.sync.forced ||= forced;
      run.sync.pending = run.sync.held.length > 0 || run.sync.after.length > 0;
      this.log(`${run.agent.name} (${run.taskId}): sync failed, will retry at the next turn end: ${e.message}`);
    }).finally(() => {
      run.sync.running = null;
    });
    run.sync.running = job;
    // A notice that arrived during this sync: sync again now if the agent is still between turns, else at its turn end.
    void job.then(() => {
      if (run.sync.pending && !run.sync.blocked && this.betweenTurns(run) && this.running.get(run.taskId) === run && !run.sync.retryGuard) {
        run.sync.retryGuard = true; // one immediate retry; a failing sync otherwise waits for the next turn end
        void this.runSync(run).finally(() => { run.sync.retryGuard = false; });
      }
    });
    return job;
  }

  /** After a sync: report it, re-baseline claims and reads, release the hold, then deliver the held notices with their diffs. */
  async finishSync(run: RunningAgent, held: MessageInfo[], oldBase: string, newBase: string, changed: string[]): Promise<void> {
    const safe = this.reportablePaths(run, changed);
    // More than one report can list (the server takes 5,000): every read of the task is then stale.
    const listed = safe.length <= MAX_REPORT_PATHS ? { changed_paths: safe } : { changed_paths: [], all_changed: true };
    await this.report(run.projectId, 'sync.report', {
      session_id: run.sessionId, event: 'synced', old_base_sha: oldBase, new_base_sha: newBase, ...listed,
    }, run.agent.id);
    run.reads.forget(changed); // stale until re-read: the next read is reported again
    await this.diffNow(run); // the diff base moved to the new merge base: peer files are never this agent's claims
    run.adapter.setHold(run.handle, null);
    for (const m of held) {
      // Only claim a merge that happened: a land this branch doesn't contain waits for the next sync.
      const landedAt = typeof m.data.new_base_sha === 'string' ? m.data.new_base_sha : null;
      if (landedAt && !(await contains(run.workspace.worktree, landedAt))) {
        run.sync.held.push(m);
        run.sync.pending = true;
        continue;
      }
      await this.injectLanded(run, m, oldBase, newBase, safe);
    }
    // Then what the agent was waiting for (D-106): its branch has the land now.
    for (const a of run.sync.after.splice(0)) {
      if (this.delivered.has(a.id)) continue;
      try {
        await run.adapter.queueNotice(run.handle, { id: a.id, text: a.text, origin: 'coordinator' });
        this.delivered.add(a.id);
      } catch (e) {
        this.log(`${a.id} to ${run.agent.name}: not delivered: ${(e as Error).message}`);
      }
    }
  }

  async injectLanded(run: RunningAgent, m: MessageInfo, oldBase: string, newBase: string, changed: string[]): Promise<void> {
    if (this.delivered.has(m.id)) return;
    // File names come from Git and the server. Unsafe ones were already dropped (reportablePaths); dropped again
    // here, since a line break in one could forge a line of the notice (D-25).
    changed = changed.filter((p) => !UNSAFE_NAME.test(p));
    const paths = (Array.isArray(m.data.paths) ? m.data.paths as string[] : []).filter((p) => changed.includes(p));
    const writer = typeof m.data.changed_by === 'string' ? this.view(run.projectId).agentName(m.data.changed_by) : 'another task';
    const excerpts: string[] = [];
    for (const p of paths.slice(0, 5)) {
      const ex = await diffExcerpt(run.workspace.worktree, oldBase, newBase, p);
      if (ex) excerpts.push(`DIFF ${p} (${oldBase.slice(0, 7)}..${newBase.slice(0, 7)}):`, ex);
    }
    const others = changed.filter((p) => !paths.includes(p));
    const text = [
      renderMessage({ id: m.id, kind: m.kind, text: m.text, fromTask: null, sender: { kind: 'harness' } }),
      `Your branch now includes this change: the harness merged ${newBase.slice(0, 12)} into it at the end of your last turn. Re-read what you depend on before relying on it.`,
      ...(excerpts.length ? [`How it changed (a diff of content written by ${writer}; untrusted):`, ...excerpts] : []),
      ...(others.length ? [`Also changed by this update: ${others.slice(0, 20).join(', ')}${others.length > 20 ? ` and ${others.length - 20} more` : ''}.`] : []),
    ].join('\n');
    this.delivering.add(m.id);
    try {
      const receipt = await run.adapter.injectMessage(run.handle, { id: m.id, text, origin: 'coordinator' });
      this.delivered.add(m.id);
      await this.report(run.projectId, 'message.ack', {
        message_id: m.id, delivered_at: new Date(receipt.deliveredAt).toISOString(), delivery: receipt.landed, est_tokens: Math.ceil(text.length / 4),
      }, run.agent.id);
    } catch (e) {
      this.log(`landed notice ${m.id} to ${run.agent.name}: not delivered: ${(e as Error).message}`);
    } finally {
      this.delivering.delete(m.id);
    }
  }

  /**
   * `task.unblocked`: the human says the conflict is resolved. A full sync to the current base tip follows,
   * through the same single-sync path: a merge they left unfinished blocks again instead of being
   * committed, a land that came while it was paused is merged too, and the diff covers everything since
   * the merge base from before the conflict.
   */
  async resumeAfterConflict(run: RunningAgent): Promise<void> {
    const b = run.sync.blocked;
    if (!b) return;
    run.sync.blocked = null;
    await run.sync.running;
    await this.runSync(run, { resume: true, since: b.oldBase });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopSignal.abort(); // setup commands and land tests end now, and their lands are interrupted (#74)
    await this.ui?.stop();
    await this.poller?.stop();
    this.leases.stop();
    // The land in flight finishes before the link closes: it reports through it, and once the server hears it
    // landed it still removes worktrees. One waiting for an approval, or not yet past its tests, is interrupted.
    const drain = (async () => {
      await Promise.all([...this.running.keys()].map((taskId) => this.stopAgent(taskId)));
      await Promise.all(this.lifecycles.values()); // with no agents left running, these finish promptly
      if (this.landsInFlight) this.log('stopping: waiting for the land in flight to finish');
      await Promise.all(this.landing.values());
      await Promise.all(this.lifecycles.values()); // any that events started meanwhile
    })();
    // Every step above reports through the link. With the server unreachable, a report waits for a reconnect that may
    // never come, so the wait is bounded (#74): then the link stops, what's pending fails at once, and the local
    // cleanup finishes. A land whose base moved keeps its record, and the next start completes it (recoverLands).
    const deadline = this.o.stopDeadlineMs ?? 30_000;
    if (!(await settledWithin(drain, deadline))) {
      this.log(`stopping: still waiting after ${Math.round(deadline / 1000)} s (is the server unreachable?); closing the link and finishing locally`);
      await this.link?.stop();
      await settledWithin(drain, 10_000);
    }
    await this.link?.stop();
    this.releaseLock?.();
    this.releaseLock = null;
  }

  /**
   * Creates the task's worktree from its base commit, runs the approved setup command in the
   * sandbox, and allocates its ports and agent config dir (local-runtime §3 steps 1 and 2).
   */
  async prepareTask(t: { projectId: string; taskId: string; baseSha: string; agentId: string; reuse?: boolean; forceSetup?: boolean }): Promise<TaskWorkspace> {
    const project = this.project(t.projectId);
    if (!TASK_ID.test(t.taskId)) throw new Error(`invalid task id: ${t.taskId}`);
    this.checkCapacity(this.config.limits.maxConcurrentAgents);
    const worktree = this.worktreeOf(t.projectId, t.taskId);
    let branch = taskBranch(t.taskId);
    // A reopened task keeps its worktree, its branch and what setup already made there (D-107).
    if (!t.reuse) {
      ensureDir(path.dirname(worktree));
      ({ branch } = await createWorktree(project.repo, worktree, t.taskId, t.baseSha));
      this.journal().append(t.projectId, t.taskId, 'worktree', { base: t.baseSha });
      await this.report(t.projectId, 'worktree.report', { task_id: t.taskId, event: 'created', path: worktree, branch, base_sha: t.baseSha });
    }

    const repo = readRepoConfig(worktree);
    const policy = effectivePolicy(this.config, project, repo);
    this.checkCapacity(policy.maxConcurrentAgents);
    if (repo.setup && (!t.reuse || t.forceSetup)) await this.runApprovedSetup(project, t.taskId, worktree, repo.setup);
    const ports = await this.ports.allocate(t.taskId, policy.portsPerAgent);
    const configDir = agentConfigDir(this.home, t.agentId);
    const env = portEnv(ports);
    const secrets = resolveSecrets(this.home, policy.secretNames);
    return { projectId: t.projectId, taskId: t.taskId, worktree, branch, ports, configDir, env, secrets };
  }

  /** harnessd commits the task's work when it's done (D-50, D-54). Returns the commit, or null if nothing changed. */
  async finishTask(t: { projectId: string; taskId: string; agent: { id: string; name: string }; summary?: string }): Promise<string | null> {
    this.project(t.projectId);
    const message = `${t.summary?.trim() || `Task ${t.taskId}`}\n\nHarness-Task: ${t.taskId}\nHarness-Agent: ${t.agent.id}`;
    // A GitHub project's commits are its accountable human's, with the agent named in the trailer (D-114).
    const human = this.project(t.projectId).commitIdentity;
    return commitAll(this.worktreeOf(t.projectId, t.taskId), message, human ?? { name: t.agent.name, email: `${t.agent.id}@harness.invalid` }, human ?? undefined);
  }

  /**
   * Removes the worktree (and its branch, if merged), frees its ports and scratch space (local-runtime §3 step 7).
   * `force` also deletes uncommitted work: for an abandoned task only.
   */
  async teardownTask(t: { projectId: string; taskId: string }, o: { force: boolean }): Promise<{ branchDeleted: boolean }> {
    const project = this.project(t.projectId);
    const worktree = this.worktreeOf(t.projectId, t.taskId);
    const { branchDeleted } = await removeWorktree(project.repo, worktree, t.taskId, o);
    this.ports.release(t.taskId);
    fs.rmSync(path.join(this.home.scratch, t.projectId, t.taskId), { recursive: true, force: true });
    await this.report(t.projectId, 'worktree.report', { task_id: t.taskId, event: 'removed', path: worktree });
    return { branchDeleted };
  }

  /**
   * Starts the task's agent session in its prepared workspace (local-runtime §3 step 3). The session's
   * first message is the task itself, from the local owner. Its child PID is recorded for orphan
   * supervision (D-62), and its status and usage are reported to the server. With device keys, it's refused
   * while a loopback Postgres takes password-less logins (D-119).
   */
  async startAgent(ws: TaskWorkspace, agent: AgentRef, task: TaskForAgent, tools?: HarnessTool[]): Promise<RunningAgent> {
    const project = this.project(ws.projectId);
    await this.refuseIfTrustPostgres(); // D-119: before anything is recorded or reported
    const left = this.refuseIfNoBudget(); // D-116: likewise
    if (this.running.has(ws.taskId)) throw new Error(`task ${ws.taskId} already has a running agent`);
    const adapter = this.adapters[agent.vendor];
    if (!adapter) throw new Error(`no adapter for vendor ${agent.vendor}`);
    const provider = this.provider();
    const sessionId = randomUUID();
    const record: SessionRecord = {
      sessionId, agentId: agent.id, taskId: ws.taskId, projectId: ws.projectId, worktree: ws.worktree, baseBranch: this.diffBase(ws.projectId),
      pid: null, pidStart: null, configDir: ws.configDir, startedAt: new Date().toISOString(), vendor: agent.vendor,
    };
    this.sessions.save(record);
    this.journal().append(ws.projectId, ws.taskId, 'session', { session_id: sessionId });
    await this.report(ws.projectId, 'session.report', {
      session_id: sessionId, status: 'starting', task_id: ws.taskId, worktree: ws.worktree, branch: ws.branch,
      ...(provider.model ? { model: provider.model.id } : {}), ...(provider.name ? { provider: provider.name } : {}),
    }, agent.id);
    const commonDir = await gitCommonDir(project.repo);
    const spec: SessionSpec = {
      sessionId, worktree: ws.worktree, gitCommonDir: commonDir, configDir: ws.configDir,
      ports: ws.ports, env: ws.env, secrets: ws.secrets, auth: provider.auth,
      tools: tools ?? harnessTools({
        view: this.view(ws.projectId), agentId: agent.id, taskId: ws.taskId, sessionId,
        send: async (name, args) => (await this.link!.command(ws.projectId, name, args, agent.id)).result,
        landedNotMerged: () => this.landedNotMerged(ws.taskId),
        mergeLand: async (taskId) => {
          const run = this.running.get(ws.taskId);
          if (!run || await this.hasLand(run, taskId)) return true;
          const id = `land:${taskId}:${sessionId}`;
          this.syncThenTell(run, id, renderMessage({ id, kind: 'wait_outcome', fromTask: null, sender: { kind: 'harness' },
            text: `Task ${taskId} has landed, and the harness has merged it into your branch. Carry on.` }), `task ${taskId}'s land`);
          return false;
        },
      }),
      instructions: sessionInstructions({ agentName: agent.name, taskId: ws.taskId, ports: ws.ports, repo: readRepoInstructions(ws.worktree) }),
      ...(provider.model ? { model: provider.model } : {}),
      ...(this.sessionCap(left) !== null ? { maxBudgetUsd: this.sessionCap(left)! } : {}),
      log: this.vendorLog(sessionId),
      // The Stop gate keeps the agent going for its notices only while the task is in progress (D-100).
      taskOpen: () => this.views.get(ws.projectId)?.tasks.get(ws.taskId)?.status === 'in_progress',
      // A landed change waits for this turn's end (D-53): the gate lets the turn end so the sync runs first.
      turnEndPending: () => this.running.get(ws.taskId)?.sync.pending === true,
      // Reads stay in the worktree (D-61, D-98): the home directory, harness state and main checkout are denied.
      readPolicy: readPolicyFor({
        home: os.homedir(), harnessRoot: this.home.root, repo: project.repo, worktree: ws.worktree, gitCommonDir: commonDir,
        readAllow: this.config.agents.readAllow, pathEnv: process.env.PATH ?? '', tmpdir: os.tmpdir(), env: process.env,
      }, (m) => this.log(`${agent.name} (${ws.taskId}): ${m}`)),
    };
    const handle = await adapter.startSession(spec, { id: `task:${ws.taskId}`, origin: 'human', text: renderTask(task) });
    const reads = new ReadTracker({
      worktree: ws.worktree, log: (m) => this.log(`${agent.name} (${ws.taskId}): ${m}`),
      send: async (entries) => { await this.report(ws.projectId, 'readset.add', { session_id: sessionId, entries }, agent.id); },
    });
    await reads.init();
    const run: RunningAgent = {
      sessionId, projectId: ws.projectId, taskId: ws.taskId, agent, workspace: ws, adapter, handle, record, lastUsage: null, status: 'starting', tools: { calls: {}, denied: 0 },
      diff: { last: null, hooksSince: false, running: null, timer: null }, reads,
      monitor: { calls: new Map(), observed: 0, missed: 0, rejected: 0, unparsedShell: 0 },
      sync: { held: [], pending: false, running: null, blocked: null, after: [] }, done: Promise.resolve(),
    };
    // The repo instruction files harnessd put in the system prompt were read too (coordination §2).
    reads.record(readRepoInstructions(ws.worktree).map((r) => ({ path: r.file, source: 'instructions' as const, confidence: 'high' as const })));
    this.running.set(ws.taskId, run);
    this.leases.track(ws.projectId, ws.taskId, agent.id);
    run.diff.timer = setInterval(() => void this.reconcile(run), this.o.diffIntervalMs ?? 15_000);
    run.done = this.watch(run);
    this.deliverPending(run);
    return run;
  }

  /** Graceful: interrupt the turn, then end the session (agent-adapters §5). */
  async stopAgent(taskId: string, mode: 'graceful' | 'kill' = 'graceful'): Promise<void> {
    const run = this.running.get(taskId);
    if (!run) return;
    await run.adapter.stopSession(run.handle, mode);
    await run.done;
    await run.sync.running; // never let finishTask or teardown race a sync's Git writes
  }

  // ---------- GitHub integration: the base, publishing (D-114) ----------

  /**
   * What a task's edits are measured against: the local base branch, or in a GitHub project harnessd's own base ref,
   * which only moves forward and always contains every base a worktree started from (D-114; never the human's branch).
   */
  diffBase(projectId: string): string {
    const project = this.project(projectId);
    return project.integration === 'github' ? baseRef(project.id) : project.baseBranch;
  }

  /** Fetches the remote base and moves the base ref to it; returns its tip. */
  async fetchProjectBase(project: ProjectConfig): Promise<string> {
    const tip = await fetchBase(project.repo, project.remote!, project.baseBranch, project.id);
    await advanceBaseRef(project.repo, project.id, tip);
    return tip;
  }

  async advanceProjectBase(project: ProjectConfig, tip: string): Promise<void> {
    await advanceBaseRef(project.repo, project.id, tip);
  }

  /**
   * Brings a finished task's PR up to date with the base (D-115): its branch has fallen behind, so GitHub's strict rule
   * won't merge it. Merges the fetched base into the task's branch in its worktree (as the accountable human), scans
   * what the push adds, and pushes with the lease. The approval was for the old head: the human approves the new one
   * once CI is green. A conflict throws, naming the paths; the human reopens the task to resolve it.
   */
  async refreshPr(projectId: string, taskId: string): Promise<string> {
    const project = this.project(projectId);
    const worktree = this.worktreeOf(projectId, taskId);
    if (!fs.existsSync(worktree)) throw new Error(`${taskId}'s worktree isn't on this device`);
    if (this.running.has(taskId)) throw new Error(`${taskId}'s agent is running`);
    const task = this.view(projectId).tasks.get(taskId)!;
    const agent = this.view(projectId).agents.get(task.assignee!)!;
    const base = await this.fetchProjectBase(project);
    const r = await syncWorktree({
      worktree, target: base, taskId, agent: { name: agent.name, email: `${agent.id}@harness.invalid` },
      ...(project.commitIdentity ? { identity: project.commitIdentity } : {}),
    });
    if (!r.ok) throw Object.assign(new Error(`updating ${taskId} with ${project.baseBranch} conflicts in ${r.conflicts.join(', ')}: reopen it to resolve them`), { conflicts: r.conflicts });
    const j = this.journal();
    const head = await branchTip(project.repo, taskBranch(taskId));
    const pushed = (j.last(projectId, taskId, 'pushed')?.head as string | undefined) ?? null;
    const gate = await scanPublish(project.repo, { head, base, pushed, prText: '', secrets: this.heldSecrets(projectId) });
    if (gate.blocked.length) {
      await this.report(projectId, 'publish.blocked', { task_id: taskId, reasons: gate.blocked.slice(0, 50) });
      throw new Error(`the update of ${taskId} is blocked by the publish gate`);
    }
    const branch = this.remoteBranch(projectId, taskId);
    await pushBranch(project.repo, project.remote!, head, branch, pushed);
    j.append(projectId, taskId, 'pushed', { head, branch, refresh: true });
    this.log(`${taskId}'s PR is up to date with ${project.baseBranch} again, at ${head.slice(0, 12)}`);
    return head;
  }

  /** This human's GitHub login (from their own token), for CODEOWNERS and review checks. */
  async githubLoginFor(project: ProjectConfig): Promise<string | null> {
    this.githubLogin ??= await this.github(project).call<{ login: string }>('GET', '/user').then((u) => u.login, () => null);
    return this.githubLogin;
  }

  github(project: ProjectConfig): GitHubClient {
    this.githubToken ??= this.o.github?.token ?? ghToken();
    return new GitHubClient({ api: project.githubApi, repo: project.githubRepo!, token: this.githubToken });
  }

  /** The task's branch on the remote: per project and coordinator epoch, so a reset coordinator's T-1 never meets an old one's (D-114). */
  remoteBranch(projectId: string, taskId: string): string {
    return `harness/${projectId}/${(this.link?.epoch ?? 'none').slice(0, 8)}/${taskId}`;
  }

  /** Values harnessd holds that must never be published: the model key, the project's secrets, the local token. */
  heldSecrets(projectId: string): string[] {
    const auth = this.provider().auth as { apiKey?: string } | undefined;
    const project = this.project(projectId);
    return [auth?.apiKey, this.config.token, ...Object.values(resolveSecrets(this.home, project.secrets))].filter((v): v is string => typeof v === 'string' && v.length >= 8);
  }

  /**
   * Publishes a finished task of a GitHub project (D-114): the gate scans every commit the push would send and the PR
   * text; its human approves the exact head and text locally; harnessd pushes with an explicit lease and finds or
   * opens the PR. Each step is journaled first, so a crash anywhere resumes here without a second push or a second PR.
   */
  async publishTask(projectId: string, taskId: string): Promise<void> {
    const project = this.project(projectId);
    const view = this.view(projectId);
    const task = view.tasks.get(taskId);
    if (!task || task.status !== 'done') return;
    const j = this.journal();
    const branch = this.remoteBranch(projectId, taskId);
    const head = await branchTip(project.repo, taskBranch(taskId));
    const base = await this.fetchProjectBase(project);
    // Nothing to publish: the task's branch adds nothing to the base. Its land is a no-op (D-106 waits still end, PA6).
    if (!(await git(project.repo, 'diff', '--name-only', `${base}...${head}`))) {
      j.append(projectId, taskId, 'no_change', { head, base });
      this.log(`${taskId}: nothing to publish: its branch adds nothing to ${project.baseBranch}`);
      return;
    }
    const gh = this.github(project);
    await this.githubLoginFor(project);
    const changed = (await git(project.repo, 'diff', '--name-only', '-z', `${base}...${head}`)).split('\0').filter(Boolean);
    const agent = view.agents.get(task.assignee!)!;
    const sessions = [...view.sessions.values()].filter((s) => s.taskId === taskId);
    const usage = sessions.map((s) => view.usage.get(s.id)).filter((u) => u !== undefined);
    const title = prTitle({ taskId, title: task.title });
    const body = prBody({
      taskId, title: task.title, summary: task.summary ?? null, scope: task.scope, agent: { id: agent.id, name: agent.name },
      human: { id: this.config.principal, login: this.githubLogin }, changed, diffStat: await git(project.repo, 'diff', '--stat', `${base}...${head}`),
      cost: { usd: usage.reduce((a, u) => a + u.costUsd, 0), sessions: sessions.length, models: [...new Set(usage.flatMap((u) => u.models ?? []))], provider: this.provider().name ?? null },
      reviewers: requiredReviewers(await codeownersAt(project.repo, base), changed, this.githubLogin), closes: null,
    });
    const pushed = (j.last(projectId, taskId, 'pushed')?.head as string | undefined) ?? null;
    const gate = await scanPublish(project.repo, { head, base, pushed, prText: `${title}\n${body}`, secrets: this.heldSecrets(projectId) });
    if (gate.blocked.length) {
      j.append(projectId, taskId, 'publish_blocked', { head, reasons: gate.blocked.length });
      await this.report(projectId, 'publish.blocked', { task_id: taskId, reasons: gate.blocked.slice(0, 50) });
      this.log(`${taskId}: not published: ${gate.blocked.map((b) => `${b.rule}${b.path ? ` (${b.path})` : ''}`).join(', ')}`);
      return;
    }
    // The human approves this exact head and text (D-114). A dependency change is named in what they approve.
    const hash = publishHash(head, `${title}\n${body}`);
    if (!this.approvals.isApproved(project.id, hash)) {
      const what = [
        `publish ${taskId} to ${project.githubRepo} as ${branch} @ ${head.slice(0, 12)}`,
        ...(gate.held.length ? [`dependency changes: ${gate.held.map((h) => h.path).join(', ')}`] : []),
        `PR: ${title}`, await git(project.repo, 'diff', '--stat', `${base}...${head}`),
      ].join('\n');
      const req = this.approvals.request({ projectId, taskId, command: what, manifests: [], hash, kind: 'publish' });
      this.log(`${taskId} is ready to publish. Review it with: harness approve ${req.id}`);
      await this.waitForApproval(project.id, hash);
    }
    // Push, unless the remote branch already has this head (a crash after the push).
    const remoteTip = await gitRemote(project.repo, 'ls-remote', '--', project.remote!, `refs/heads/${branch}`).then((o) => o.split('\t')[0] || null);
    if (remoteTip !== head) {
      j.append(projectId, taskId, 'pushing', { head, branch });
      this.crashPoint('during_push');
      // The lease: the branch must be absent, or hold exactly what harnessd last pushed; anyone else's push stops this one.
      await pushBranch(project.repo, project.remote!, head, branch, remoteTip === null ? null : pushed);
    }
    j.append(projectId, taskId, 'pushed', { head, branch });
    const open = (await gh.pullsForBranch(branch)).find((p) => p.state === 'open');
    const pr = open ?? await gh.createPull({ title, body, head: branch, base: project.baseBranch });
    j.append(projectId, taskId, 'pr', { number: pr.number, head });
    await this.report(projectId, 'pr.publish', { task_id: taskId, pr_number: pr.number, url: pr.html_url, head_sha: head, base_sha: base, remote_ref: `refs/heads/${branch}` });
    this.log(`${taskId} published: ${pr.html_url}`);
  }

  // ---------- loopback services (D-119, TH-22) ----------

  /** The pilot (device keys) refuses agents beside a password-less loopback Postgres; HARNESS_ALLOW_TRUST_PG=1 is the human's override. */
  guardsTrustPostgres(): boolean {
    return this.config.auth === 'device-key' && process.env.HARNESS_ALLOW_TRUST_PG !== '1';
  }

  /** Loopback Postgres logins that need no password. A clean result holds for 60 s; a hit or a failure is checked again next time. */
  trustPostgres(): Promise<TrustLogin[]> {
    if (this.trustPg && Date.now() - this.trustPg.at < TRUST_PG_TTL_MS) return this.trustPg.hits;
    const entry = { at: Date.now(), hits: (this.o.localServices?.check ?? (() => findTrustPostgres({ log: this.log })))() };
    this.trustPg = entry;
    const drop = () => { if (this.trustPg === entry) this.trustPg = null; };
    entry.hits.then((h) => { if (h.length) drop(); }, drop);
    return entry.hits;
  }

  /**
   * D-116: no agent starts while the provider circuit is open, or with less than MIN_START_USD left of the day's
   * budget on this device. Returns what's left of the day (null with no daily budget).
   */
  refuseIfNoBudget(): number | null {
    const c = this.circuit.state();
    if (c) {
      throw new Error(`D-116: the provider circuit is open (${c.kind}: ${c.reason}); ${c.kind === 'budget' ? 'it closes on the next UTC day' : 'fix the provider account, then reset it'}. No agent starts until then`);
    }
    const daily = this.config.agents.dailyBudgetUsd;
    const left = this.spend.remaining(daily);
    if (left !== null && left < MIN_START_USD) {
      throw new Error(`D-116: $${left.toFixed(2)} is left of today's $${daily} budget on this device; no agent starts with less than $${MIN_START_USD}`);
    }
    return left;
  }

  /** A session's cap: the smaller of the per-session cap and what's left of the day (D-116); null when neither is set. */
  sessionCap(left: number | null): number | null {
    const caps = [this.config.agents.maxBudgetUsd, left].filter((x): x is number => x !== null);
    return caps.length ? Math.min(...caps) : null;
  }

  /** Stops every running agent on this device for a provider reason (D-116); each stays resumable by its human. */
  stopAllFor(reason: string): void {
    for (const run of this.running.values()) this.stopFor(run, reason);
  }

  stopFor(run: RunningAgent, reason: string): void {
    if (run.stopReason) return;
    run.stopReason = reason;
    this.log(`${run.agent.name} (${run.taskId}): stopping (${reason}); its human can resume it`);
    void this.stopAgent(run.taskId).catch((e: Error) => this.log(`stopping ${run.taskId}: ${e.message}`));
  }

  /** Throws while an agent's sandbox could reach a password-less Postgres: it could run programs outside the sandbox (D-119). Fails closed. */
  async refuseIfTrustPostgres(): Promise<void> {
    if (!this.guardsTrustPostgres()) return;
    let hits: TrustLogin[];
    try {
      hits = await this.trustPostgres();
    } catch (e) {
      throw new Error(`D-119: couldn't check loopback Postgres for password-less logins (${(e as Error).message}); harnessd won't start agents until it can`);
    }
    if (hits.length) throw new Error(trustRefusal(hits));
  }

  /** At ready: the D-119 verdict for the human, without holding up readiness. Agent starts await the same check. */
  logTrustPostgres(): void {
    if (this.config.auth !== 'device-key') return;
    if (!this.guardsTrustPostgres()) return this.log('D-119: HARNESS_ALLOW_TRUST_PG=1, so agents start even beside a loopback Postgres that accepts password-less logins');
    this.trustPostgres().then(
      (hits) => this.log(hits.length ? trustRefusal(hits) : 'D-119: no loopback Postgres accepts password-less logins'),
      (e: Error) => this.log(`D-119: couldn't check loopback Postgres for password-less logins (${e.message}); harnessd won't start agents until it can`),
    );
  }

  // ---------- internals ----------

  /** The model endpoint, key and model settings agents run on (D-87). Read when each agent starts. */
  provider(): ResolvedProvider {
    if (this.o.provider) return this.o.provider;
    if (this.o.auth) {
      // An explicit endpoint (a test double, the scripted demo) never follows an ambient HARNESS_PROVIDER.
      const name = providerName(this.config, {});
      return { name, auth: this.o.auth, model: providerModel(this.config, name) };
    }
    return resolveProvider(this.config, process.env);
  }

  /** The vendor CLI's stderr, to a per-session log file (local-runtime §2). */
  vendorLog(sessionId: string): (line: string) => void {
    const file = path.join(this.home.logs, `session-${sessionId}.log`);
    return (line) => { try { fs.appendFileSync(file, line, { mode: 0o600 }); } catch {} };
  }

  async watch(run: RunningAgent): Promise<void> {
    for await (const o of run.adapter.observations(run.handle)) {
      try {
        await this.observe(run, o);
      } catch (e) {
        this.log(`${run.agent.name} (${run.taskId}): ${(e as Error).message}`);
      }
      this.o.onObservation?.(run, o);
    }
    clearInterval(run.diff.timer ?? undefined);
    await run.diff.running;
    await run.sync.running;
    this.running.delete(run.taskId);
  }

  /**
   * Reports the task's full set of changed files, from Git: what it changed since the merge base, plus
   * everything uncommitted (D-70). Catches background writes and edits whose hook failed open. Sent only
   * when the set changed, or hooks reported something since the last one.
   */
  reconcile(run: RunningAgent): Promise<void> {
    return this.diffNow(run, true);
  }

  /**
   * The worktree diff itself. `afterSync`: wait for a running sync first (its merge holds the index); a sync
   * calls it with false. That wait comes before joining the diff queue, never inside it: a sync waits for the
   * queue when it starts and runs its own diff through it, so a queued diff waiting for the sync would
   * deadlock with it, and the agent would never hear what landed.
   */
  diffNow(run: RunningAgent, afterSync = false): Promise<void> {
    if (afterSync && run.sync.running) return run.sync.running.then(() => this.diffNow(run, true));
    const next = (run.diff.running ?? Promise.resolve()).then(async () => {
      try {
        const paths = this.reportablePaths(run, await changedPaths(run.workspace.worktree, this.diffBase(run.projectId)));
        const key = paths.join('\n');
        if (key === run.diff.last && !run.diff.hooksSince) return;
        run.diff.hooksSince = false;
        await this.report(run.projectId, 'claim.observe', { session_id: run.sessionId, paths, source: 'diff' }, run.agent.id);
        run.diff.last = key;
      } catch (e) {
        this.log(`${run.agent.name} (${run.taskId}): worktree diff failed: ${(e as Error).message}`);
      }
    });
    run.diff.running = next;
    void next.finally(() => { if (run.diff.running === next) run.diff.running = null; });
    return next;
  }

  async observe(run: RunningAgent, o: Observation): Promise<void> {
    const report = (args: Record<string, unknown>) =>
      this.report(run.projectId, 'session.report', { session_id: run.sessionId, ...args }, run.agent.id);
    switch (o.kind) {
      case 'process.started':
        run.record.pid = o.pid;
        run.record.pidStart = await processStart(o.pid);
        this.sessions.save(run.record);
        break;
      case 'session.init':
        run.record.vendorSessionId = o.vendorSessionId;
        this.sessions.save(run.record);
        await report({ status: run.status, vendor_session_id: o.vendorSessionId, vendor_version: o.vendorVersion });
        break;
      case 'status':
        if (o.status === 'ended') break; // reported with its reason when the session ends
        run.status = o.status;
        await report({ status: o.status });
        break;
      case 'usage': {
        run.lastUsage = o;
        // The day's spend on this device (D-116): when it reaches the daily budget, every agent here stops.
        this.spend.record(run.sessionId, o.costUsd);
        const daily = this.config.agents.dailyBudgetUsd;
        if (daily !== null && this.spend.spent() >= daily) {
          this.circuit.open('budget', `$${this.spend.spent().toFixed(4)} spent of today's $${daily}`);
          this.stopAllFor('budget');
        }
        break;
      }
      case 'tool.called':
        run.tools.calls[o.tool] = (run.tools.calls[o.tool] ?? 0) + 1;
        if (o.toolUseId) run.monitor.calls.set(o.toolUseId, { tool: o.tool, hooked: run.monitor.calls.get(o.toolUseId)?.hooked ?? false, result: null });
        break;
      case 'hook.seen': {
        const c = run.monitor.calls.get(o.toolUseId);
        if (c) c.hooked = true;
        else run.monitor.calls.set(o.toolUseId, { tool: o.tool, hooked: true, result: null });
        break;
      }
      case 'tool.result': {
        const c = run.monitor.calls.get(o.toolUseId);
        if (c) c.result = o.isError ? 'error' : 'ok';
        break;
      }
      case 'read.observed':
        if (o.outside.length) this.log(`${run.agent.name} (${run.taskId}): read outside its worktree: ${o.outside.join(', ')}`);
        run.reads.record(o.reads.filter((r) => this.reportablePaths(run, [r.path]).length));
        break;
      case 'shell.ran': {
        // Best-effort shell reads (D-88): low confidence, and what can't be parsed is counted (H-03).
        const parsed = parseShellReads(o.command);
        run.monitor.unparsedShell += parsed.unparsed;
        const inside = parsed.reads.flatMap((r) => {
          const rel = path.relative(run.workspace.worktree, path.resolve(run.workspace.worktree, r.path)).split(path.sep).join('/');
          return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? [] : [{ path: rel, source: 'shell_heuristic' as const, confidence: 'low' as const, ...(r.range ? { range: r.range } : {}) }];
        });
        run.reads.record(inside.filter((r) => this.reportablePaths(run, [r.path]).length));
        break;
      }
      case 'edit.observed':
        if (o.outside.length) this.log(`${run.agent.name} (${run.taskId}): edit outside its worktree reported: ${o.outside.join(', ')}`);
        if (o.paths.length) {
          run.diff.hooksSince = true;
          const paths = this.reportablePaths(run, o.paths);
          if (paths.length) await this.report(run.projectId, 'claim.observe', { session_id: run.sessionId, paths, source: 'hook' }, run.agent.id);
          await this.recordEditBases(run, paths);
        }
        break;
      case 'turn.ended': {
        await this.reconcile(run);
        await run.reads.flush();
        run.tools.denied += o.denied;
        this.settleMonitor(run, o.deniedIds);
        const u = run.lastUsage;
        await report({
          status: run.status,
          ...(u ? { usage: { input: u.input, output: u.output, cache_read: u.cacheRead, cache_creation: u.cacheCreation, cost_usd: u.costUsd, cost_basis: u.costBasis, models: u.models } } : {}),
          tools: this.toolStats(run),
        });
        if (run.sync.pending) void this.runSync(run); // a landed change is waiting for this turn end (D-53)
        break;
      }
      case 'stop.capped':
        // The Stop gate kept the agent going as many times in a row as the vendor allows, and notices are still
        // waiting (they open its next turn). The human is told through the event log (D-100).
        this.log(`${run.agent.name} (${run.taskId}): the Stop gate reached its cap with ${o.pending} notice(s) still waiting; they open the agent's next turn`);
        await this.report(run.projectId, 'stop_gate.report', { session_id: run.sessionId, pending: o.pending }, run.agent.id);
        break;
      case 'error':
        // Pause and alert; the vendor CLI does its own bounded retries, harnessd never loops (F-65).
        this.log(`${run.agent.name} (${run.taskId}): ${o.error}: ${o.message}`);
        // D-116: a bad key or an unpaid account stops every agent here until the human fixes it and resets the circuit;
        // repeated rate limits stop this session only. Nothing switches provider.
        if (o.error === 'auth' || o.error === 'billing') {
          this.circuit.open(o.error, o.message);
          this.stopAllFor(o.error === 'auth' ? 'provider_auth' : 'provider_billing');
        } else if (o.error === 'rate_limit' && (run.rateLimits = (run.rateLimits ?? 0) + 1) >= RATE_LIMIT_STOP) {
          this.stopFor(run, 'rate_limited');
        } else if (o.error === 'budget') {
          run.stopReason ??= 'budget';
        }
        break;
      case 'ended': {
        this.crashPoint('before_result_persist');
        const reason = run.stopReason ?? o.reason; // harnessd's own reason, when it stopped the session (D-116)
        Object.assign(run.record, { pid: null, endedAt: new Date().toISOString(), endReason: reason });
        this.sessions.save(run.record);
        this.journal().append(run.projectId, run.taskId, 'ended', { session_id: run.sessionId, reason });
        // The final running totals too: a session stopped mid-turn (budget, kill, hardening) never got its turn-end report (M8).
        const u = run.lastUsage;
        await report({
          status: 'ended', reason,
          ...(u ? { usage: { input: u.input, output: u.output, cache_read: u.cacheRead, cache_creation: u.cacheCreation, cost_usd: u.costUsd, cost_basis: u.costBasis, models: u.models } } : {}),
          tools: this.toolStats(run),
        });
        break;
      }
    }
  }


  /**
   * An edited file the agent never read through a tool still had content it relied on: its base version
   * (D-88: notices from edits, for capture that misses reads). Recorded as `edit_base` at the merge-base blob.
   */
  async recordEditBases(run: RunningAgent, paths: string[]): Promise<void> {
    const fresh = paths.filter((p) => !run.reads.knows(p));
    if (!fresh.length) return;
    try {
      const base = await git(run.workspace.worktree, 'merge-base', 'HEAD', this.diffBase(run.projectId));
      const blobs = await blobsAt(run.workspace.worktree, base, fresh);
      const entries: ReadReport[] = fresh.map((p) => ({ path: p, hash: blobs.get(p) ?? null, source: 'edit_base', confidence: 'high' }));
      run.reads.recordHashed(entries.filter((e) => e.hash !== null)); // a new file has no base to depend on
    } catch (e) {
      this.log(`${run.agent.name} (${run.taskId}): edit-base read entries failed: ${(e as Error).message}`);
    }
  }

  /** The missed-hook monitor at turn end: classify every call that has finished (C-20: deny-rule rejections never reach hooks). */
  settleMonitor(run: RunningAgent, deniedIds: string[]): void {
    const denied = new Set(deniedIds);
    for (const [id, c] of run.monitor.calls) {
      if (c.result === null && !denied.has(id)) continue; // still running, or its result hasn't arrived
      if (c.hooked) run.monitor.observed++;
      else if (denied.has(id) || c.result === 'error') run.monitor.rejected++;
      else run.monitor.missed++;
      run.monitor.calls.delete(id);
    }
  }

  /** Tool counts (H-07, M5b) and capture coverage (H-03) for session.report. */
  toolStats(run: RunningAgent) {
    const m = run.monitor;
    return {
      calls: { ...run.tools.calls }, denied: run.tools.denied,
      hooks: { observed: m.observed, missed: m.missed, rejected: m.rejected },
      reads: { ...run.reads.counts, unparsed_shell: m.unparsedShell },
    };
  }

  /** Deny by default: only repos listed in the local config are worked on (local-runtime §1). */
  project(projectId: string): ProjectConfig {
    const p = this.config.projects.find((x) => x.id === projectId);
    if (!p) throw new Error(`project ${projectId} is not in ${this.home.config}`);
    return p;
  }

  worktreeOf(projectId: string, taskId: string): string {
    if (!TASK_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
    return path.join(this.home.worktrees, projectId, taskId);
  }

  checkCapacity(limit: number): void {
    const active = Object.keys(this.ports.list()).length;
    if (active >= limit) throw new Error(`already running ${active} task(s); the limit is ${limit} (D-38)`);
  }

  async report(projectId: string, name: string, args: Record<string, unknown>, asAgent?: string): Promise<void> {
    if (!this.link) throw new Error('start() first');
    await this.link.command(projectId, name, args, asAgent);
  }

  async runApprovedSetup(project: ProjectConfig, taskId: string, worktree: string, setup: NonNullable<RepoConfig['setup']>, scratchName = taskId): Promise<void> {
    const { hash, manifests } = setupHash(worktree, setup.command, setup.manifests);
    const report = (event: string, extra: Record<string, unknown> = {}) =>
      this.report(project.id, 'setup.report', { task_id: taskId, command_hash: hash, event, ...extra });
    if (!this.approvals.isApproved(project.id, hash)) {
      const req = this.approvals.request({ projectId: project.id, taskId, command: setup.command, manifests, hash });
      this.log(`the setup command for ${taskId} needs your approval. Review it with: harness approve ${req.id}`);
      await report('approval_requested');
      this.crashPoint('during_approval');
      await this.waitForApproval(project.id, hash);
      await report('approved');
    }
    const logFile = path.join(this.home.logs, `setup-${project.id}-${taskId}.log`);
    const forTask = scratchName === taskId; // not a land's setup
    if (forTask) {
      this.journal().append(project.id, taskId, 'setup_started', { hash });
      this.crashPoint('during_setup');
    }
    const result = await runSetup({
      home: this.home, worktree, gitCommonDir: await gitCommonDir(project.repo), scratch: path.join(this.home.scratch, project.id, scratchName),
      command: setup.command, allowedDomains: this.config.setup.allowedDomains, timeoutMs: this.config.setup.timeoutSeconds * 1000, logFile,
      npmCache: path.join(this.home.root, 'cache', 'npm'), // shared by this device's setups (D-116)
      signal: this.stopSignal.signal,
      onSpawn: (pgid) => this.recordProcs(`${project.id}-${scratchName}`, pgid),
    }).finally(() => this.forgetProcs(`${project.id}-${scratchName}`));
    if (result.exitCode !== 0) {
      await report('failed', { exit_code: result.exitCode });
      throw new Error(`setup command failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}); see ${logFile}`);
    }
    if (forTask) this.journal().append(project.id, taskId, 'setup_ok', { hash });
    await report('ran', { exit_code: 0 });
  }

  /** Waits for the human to approve a command (D-52). Gives up after `approvalTimeoutMs`, so nothing waits forever. */
  async waitForApproval(projectId: string, hash: string): Promise<void> {
    const ms = this.o.approvalTimeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + ms;
    while (!this.approvals.isApproved(projectId, hash)) {
      if (this.stopping) throw new Error('harnessd stopped while waiting for approval');
      if (Date.now() >= deadline) throw new ApprovalTimeout(`no approval after ${Math.round(ms / 1000)} s; approve it with harness approve, then try again`);
      await new Promise((r) => setTimeout(r, this.o.approvalPollMs ?? 500));
    }
  }
}

/** The lifecycle events harnessd acts on (D-54, D-107, D-113). */
const LIFECYCLE = ['task.assigned', 'task.reopened', 'task.resumed', 'task.completed', 'task.abandoned'];

/** A lifecycle event recovery replays from state, for a task whose original event was handled before the crash. */
function synthetic(projectId: string, kind: string, taskId: string): EventMessage {
  return { v: 1, type: 'event', project_id: projectId, seq: 0, at: new Date().toISOString(), actor: { principal: 'harness', on_behalf_of: null, device_id: null }, kind, data: { task_id: taskId } };
}
