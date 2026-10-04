// harnessd v0 (0A item 4; docs/local-runtime.md). The per-device execution and security boundary
// (D-32): it prepares and tears down task workspaces, owns their Git writes, runs approved setup
// commands sandboxed, hands out ports and agent config dirs, tracks agent processes, and keeps a
// connection to the coordination server. It runs agent sessions only through @harness/adapters
// (D-17). Acting on task assignments arrives with the lifecycle (item 9).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeAdapter, type AgentAdapter, type Auth, type HarnessTool, type Observation, type SessionHandle, type SessionSpec, type SessionStatus,
} from '@harness/adapters';
import type { EventMessage } from '@harness/protocol';
import { Approvals, setupHash, testHash } from './approvals.ts';
import { loadConfig, resolveSecrets, type LocalConfig, type ProjectConfig } from './config.ts';
import { branchTip, changedPaths, commitAll, createWorktree, git, gitCommonDir, removeWorktree, TASK_ID, taskBranch } from './git.ts';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';
import { ServerLink } from './link.ts';
import { effectivePolicy, readRepoConfig, type RepoConfig } from './repo-config.ts';
import { agentConfigDir, PortAllocator, portEnv, type PortBlock } from './resources.ts';
import { runSetup } from './setup.ts';
import { renderMessage, renderTask, type MessageForAgent, type TaskForAgent } from './envelope.ts';
import { readRepoInstructions, sessionInstructions } from './instructions.ts';
import {
  addIntegrationWorktree, advanceBase, blobsAt, changedBetween, deleteMergedBranch, diffExcerpt, mergeCommit, removeIntegrationWorktree,
} from './integrate.ts';
import { contains, syncWorktree, unresolved } from './sync.ts';
import { ReadTracker, type ReadReport } from './reads.ts';
import { parseShellReads } from './shellreads.ts';
import { providerModel, providerName, resolveProvider, type ResolvedProvider } from './provider.ts';
import { killOrphans, processStart, Sessions, type OrphanReport, type SessionRecord } from './supervision.ts';
import { harnessTools } from './tools.ts';
import { LeaseKeeper, type LeaseFaults } from './leases.ts';
import { readPolicyFor } from './readpolicy.ts';
import { ProjectView, type MessageInfo } from './view.ts';

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
   * the one running (deliveries wait for it); and, after a conflict, what the human must resolve.
   */
  sync: { held: MessageInfo[]; pending: boolean; running: Promise<void> | null; blocked: { target: string; oldBase: string } | null; retryGuard?: boolean };
  done: Promise<void>;
};

const SYNC_HOLD = 'The harness is updating your branch with work that just landed. Wait for its notice, then carry on.';
const BLOCKED_HOLD = 'This task is paused: updating your branch with work that landed conflicted, and your human is resolving it. Stop and wait.';
/** The most paths one report to the server lists (its own cap, kept under its message size limit). */
const MAX_REPORT_PATHS = 5000;
/** Nobody approved a setup or test command in time (D-52); a land that hits it fails as `not_approved`. */
export class ApprovalTimeout extends Error {}
export type DaemonOptions = {
  home: Home; config?: LocalConfig;
  log?: (msg: string) => void; onEvent?: (e: EventMessage) => void;
  onObservation?: (run: RunningAgent, o: Observation) => void;
  heartbeatMs?: number; approvalPollMs?: number;
  /** How long a setup or test command waits for `harness approve` before giving up. Default 30 minutes. */
  approvalTimeoutMs?: number;
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
  /** Fault injection, for tests only (T-2). */
  faults?: { leases?: LeaseFaults };
};

export class Daemon {
  home: Home;
  config: LocalConfig;
  log: (msg: string) => void;
  o: DaemonOptions;
  approvals: Approvals;
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
  leases: LeaseKeeper; // renews this device's tasks' leases, presents them at land (D-97)

  constructor(o: DaemonOptions) {
    this.o = o;
    this.home = o.home;
    this.config = o.config ?? loadConfig(o.home);
    this.log = o.log ?? (() => {});
    this.approvals = new Approvals(this.home);
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
    });
  }

  async start(): Promise<void> {
    for (const d of [this.home.root, this.home.worktrees, this.home.scratch, this.home.sessions, this.home.vendor, this.home.logs, this.home.pending]) ensureDir(d);
    this.orphans = await killOrphans(this.sessions);
    for (const o of this.orphans) {
      this.log(`killed orphaned agent process ${o.pid} (session ${o.sessionId}, task ${o.taskId}); changed: ${o.changedPaths.join(', ') || 'nothing'}`);
    }
    const saved = readJson<{ cursors: Record<string, number> }>(this.home.state, { cursors: {} }).cursors;
    this.link = new ServerLink({
      url: this.config.serverUrl, token: this.config.token, principal: this.config.principal, deviceId: this.config.deviceId,
      cursors: Object.fromEntries(this.config.projects.map((p) => [p.id, saved[p.id] ?? 0])),
      onEvent: (e, replayed) => this.onEvent(e, replayed),
      onCursor: () => writeJsonAtomic(this.home.state, { cursors: this.link!.cursors }),
      ...(this.o.heartbeatMs ? { heartbeatMs: this.o.heartbeatMs } : {}),
      log: this.log,
    });
    this.link.start();
  }

  /** Resolves once the server has welcomed this daemon and it has replayed each project's log. */
  async ready(): Promise<void> {
    if (!this.link) throw new Error('start() first');
    await this.link.whenReady();
    await this.link.whenCaughtUp();
    this.recoverLands();
    this.leases.start();
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
    if (e.kind === 'task.assigned' || e.kind === 'task.completed' || e.kind === 'task.abandoned') {
      const taskId = (e.data as { task_id: string }).task_id;
      const next: Promise<void> = (this.lifecycles.get(taskId) ?? Promise.resolve())
        .then(() => this.lifecycle(e))
        .catch((err: Error) => this.log(`${e.kind} ${taskId}: ${err.message}`))
        .finally(() => { if (this.lifecycles.get(taskId) === next) this.lifecycles.delete(taskId); });
      this.lifecycles.set(taskId, next);
    }
    if (e.kind === 'message.sent') {
      const m = this.view(e.project_id).messages.get((e.data as { message_id: string }).message_id);
      // A message for a task goes to that task's run; an agent may still be winding down its previous one.
      const run = m?.to ? [...this.running.values()].find((r) => r.projectId === e.project_id && r.agent.id === m.to && (!m.toTask || r.taskId === m.toTask)) : undefined;
      if (m && run) void this.deliver(run, m);
    }
    if (e.kind === 'land.requested' && (e.data as { device_id?: string }).device_id === this.config.deviceId) {
      const d = e.data as { land_id: string; task_id: string; run_tests?: boolean };
      this.queueLand(e.project_id, () => this.land(e.project_id, d.land_id, d.task_id, d.run_tests !== false));
    }
    if (e.kind === 'task.unblocked') {
      const run = this.running.get((e.data as { task_id: string }).task_id);
      if (run?.sync.blocked) void this.resumeAfterConflict(run);
    }
  }

  /**
   * The task lifecycle on this device (D-54), for agents accountable to this daemon's human:
   * - assigned: create the worktree from the base branch's tip, run setup, start the agent;
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
    if (e.kind === 'task.assigned') {
      if (!this.adapters[agent.vendor]) throw new Error(`no adapter for ${agent.vendor} on this device`);
      const baseSha = await branchTip(project.repo, project.baseBranch);
      const ws = await this.prepareTask({ projectId: project.id, taskId, baseSha, agentId: agent.id });
      if (this.stopping) return;
      await this.startAgent(ws, ref, { id: task.id, title: task.title, text: task.text, scope: task.scope, ownerHumanId: task.ownerHumanId });
      this.log(`${agent.name} started on ${taskId} in ${ws.worktree}`);
    } else if (e.kind === 'task.completed') {
      const run = this.running.get(taskId);
      if (run) {
        await this.untilIdle(run, this.o.finishGraceMs ?? 60_000);
        await this.stopAgent(taskId);
      }
      const worktree = this.worktreeOf(project.id, taskId);
      if (!fs.existsSync(worktree)) return;
      const commit = await this.finishTask({ projectId: project.id, taskId, agent: ref, ...(task.summary ? { summary: task.summary } : {}) });
      this.ports.release(taskId);
      if (commit) await this.report(project.id, 'worktree.report', { task_id: taskId, event: 'committed', path: worktree, branch: `harness/task/${taskId}`, commit });
      this.log(`${taskId} done: ${commit ? `committed ${commit.slice(0, 12)} on harness/task/${taskId}` : 'nothing to commit'}`);
    } else {
      if (this.running.has(taskId)) await this.stopAgent(taskId, 'kill');
      this.leases.untrack(taskId);
      if (fs.existsSync(this.worktreeOf(project.id, taskId))) await this.teardownTask({ projectId: project.id, taskId }, { force: true });
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
   * Injects a message into the recipient's live session at its next safe boundary (D-26), rendered in
   * its envelope (D-25), then acknowledges where it landed. Held (over-budget) messages are never
   * delivered. Messages for an agent with no live session wait in the log until its session starts.
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
        sender: m.from === 'harness' ? { kind: 'harness' }
          : sender ? { kind: 'agent', name: sender.name, humanId: sender.humanId }
          : { kind: 'human', id: m.from, local: m.from === this.config.principal },
      };
      const text = renderMessage(msg);
      const origin = msg.sender.kind === 'harness' ? 'coordinator' : msg.sender.kind === 'human' && msg.sender.local ? 'human' : 'peer';
      const receipt = await run.adapter.injectMessage(run.handle, { id: m.id, text, origin });
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
   * File names with control characters are never reported: they'd end up in other agents' notices,
   * where a newline could forge a line (D-25). They're logged for the human instead.
   */
  reportablePaths(run: RunningAgent, paths: string[]): string[] {
    const bad = paths.filter((p) => /[\u0000-\u001f\u007f]/.test(p));
    if (bad.length) this.log(`${run.agent.name} (${run.taskId}): not reporting ${bad.length} file name(s) with control characters: ${JSON.stringify(bad)}`);
    return paths.filter((p) => !bad.includes(p));
  }

  /** Messages that arrived while the agent had no live session, or while it was paused. */
  deliverPending(run: RunningAgent): void {
    const view = this.view(run.projectId);
    const pending = [...view.messages.values()]
      .filter((m) => m.to === run.agent.id && (!m.toTask || m.toTask === run.taskId) && !m.held && !m.deliveredAt && !m.supersededBy)
      .sort((a, b) => a.seq - b.seq);
    for (const m of pending) void this.deliver(run, m);
  }

  // ---------- the land step (0B item 5; D-51, D-54; local-runtime.md §4) ----------

  queueLand(projectId: string, job: () => Promise<void>): void {
    const next = (this.landing.get(projectId) ?? Promise.resolve()).then(job).catch((e: Error) => this.log(`land: ${e.message}`));
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
        await step('testing');
        const logFile = path.join(this.home.logs, `land-${landId}.log`);
        const timeout = Math.min(repo.test.timeoutSeconds ?? this.config.setup.timeoutSeconds, this.config.setup.timeoutSeconds);
        const result = await runSetup({
          home: this.home, worktree: dir, gitCommonDir: await gitCommonDir(project.repo), scratch: path.join(this.home.scratch, project.id, `land-${landId}`),
          command: repo.test.command, allowedDomains: [], allowLocalBinding: true, timeoutMs: timeout * 1000, logFile,
        });
        if (result.exitCode !== 0) {
          const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n') : '';
          return void await fail('tests', `${result.timedOut ? 'timed out' : `exit ${result.exitCode}`}\n${tail}`);
        }
        await step('tested');
      }
      writeJsonAtomic(this.landFile(landId), { projectId, landId, taskId, baseSha, head, dir, merge: m.commit });
      const adv = await advanceBase(project.repo, project.baseBranch, baseSha, m.commit);
      if (!adv.ok) return void await fail(adv.reason, adv.detail);
      moved = true;
      await this.completeLand(projectId, landId, taskId, baseSha, m.commit, head);
    } catch (e) {
      // Once the base has moved, the land happened: never report it failed. The record stays for a retry
      // now and for recovery at the next start.
      if (!moved) await fail(e instanceof ApprovalTimeout ? 'not_approved' : 'error', (e as Error).message).catch(() => {});
      else {
        this.log(`land of ${taskId}: the base moved, but reporting it failed (${(e as Error).message}); retrying`);
        const saved = readJson<{ merge: string | null } | null>(this.landFile(landId), null);
        for (let i = 1; i <= 3 && saved?.merge; i++) {
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
      changed: changed.filter((p) => !/[\u0000-\u001f\u007f]/.test(p)).map((p) => ({ path: p, new_hash: blobs.get(p) ?? null })),
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

  /**
   * After a restart: lands this device was asked to run while it was away start now; one interrupted after
   * the base moved is completed (even if a human cancelled it meanwhile: the change is in the base); one
   * interrupted before is failed, with the base untouched.
   */
  recoverLands(): void {
    for (const p of this.config.projects) {
      for (const l of this.view(p.id).lands.values()) {
        if (l.deviceId !== this.config.deviceId) continue;
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
    let held: MessageInfo[] = [];
    const job = (async () => {
      await run.diff.running; // never alongside a worktree diff: both use the index
      const view = this.view(run.projectId);
      held = run.sync.held.splice(0).map((m) => view.messages.get(m.id) ?? m).filter((m) => !m.deliveredAt && !m.supersededBy);
      if (!held.length && !opts.resume) return;
      const project = this.project(run.projectId);
      const worktree = run.workspace.worktree;
      run.adapter.setHold(run.handle, SYNC_HOLD);
      let release = true;
      try {
        const target = await branchTip(project.repo, project.baseBranch);
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
        const r = await syncWorktree({ worktree, target, taskId: run.taskId, agent: { name: run.agent.name, email: `${run.agent.id}@harness.invalid` } });
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
      run.sync.pending = run.sync.held.length > 0;
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
  }

  async injectLanded(run: RunningAgent, m: MessageInfo, oldBase: string, newBase: string, changed: string[]): Promise<void> {
    if (this.delivered.has(m.id)) return;
    // File names come from Git and the server. Any with control characters were already dropped (reportablePaths);
    // dropped again here, since a newline in one could forge a line of the notice (D-25).
    changed = changed.filter((p) => !/[\u0000-\u001f\u007f]/.test(p));
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
    this.leases.stop();
    await Promise.all([...this.running.keys()].map((taskId) => this.stopAgent(taskId)));
    await Promise.all(this.lifecycles.values()); // with no agents left running, these finish promptly
    await this.link?.stop();
  }

  /**
   * Creates the task's worktree from its base commit, runs the approved setup command in the
   * sandbox, and allocates its ports and agent config dir (local-runtime §3 steps 1 and 2).
   */
  async prepareTask(t: { projectId: string; taskId: string; baseSha: string; agentId: string }): Promise<TaskWorkspace> {
    const project = this.project(t.projectId);
    if (!TASK_ID.test(t.taskId)) throw new Error(`invalid task id: ${t.taskId}`);
    this.checkCapacity(this.config.limits.maxConcurrentAgents);
    const worktree = this.worktreeOf(t.projectId, t.taskId);
    ensureDir(path.dirname(worktree));
    const { branch } = await createWorktree(project.repo, worktree, t.taskId, t.baseSha);
    await this.report(t.projectId, 'worktree.report', { task_id: t.taskId, event: 'created', path: worktree, branch, base_sha: t.baseSha });

    const repo = readRepoConfig(worktree);
    const policy = effectivePolicy(this.config, project, repo);
    this.checkCapacity(policy.maxConcurrentAgents);
    if (repo.setup) await this.runApprovedSetup(project, t.taskId, worktree, repo.setup);
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
    return commitAll(this.worktreeOf(t.projectId, t.taskId), message, { name: t.agent.name, email: `${t.agent.id}@harness.invalid` });
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
   * supervision (D-62), and its status and usage are reported to the server.
   */
  async startAgent(ws: TaskWorkspace, agent: AgentRef, task: TaskForAgent, tools?: HarnessTool[]): Promise<RunningAgent> {
    const project = this.project(ws.projectId);
    if (this.running.has(ws.taskId)) throw new Error(`task ${ws.taskId} already has a running agent`);
    const adapter = this.adapters[agent.vendor];
    if (!adapter) throw new Error(`no adapter for vendor ${agent.vendor}`);
    const provider = this.provider();
    const sessionId = randomUUID();
    const record: SessionRecord = {
      sessionId, agentId: agent.id, taskId: ws.taskId, projectId: ws.projectId, worktree: ws.worktree, baseBranch: project.baseBranch,
      pid: null, pidStart: null, configDir: ws.configDir, startedAt: new Date().toISOString(), vendor: agent.vendor,
    };
    this.sessions.save(record);
    await this.report(ws.projectId, 'session.report', {
      session_id: sessionId, status: 'starting', task_id: ws.taskId, worktree: ws.worktree, branch: ws.branch,
      ...(provider.model ? { model: provider.model.id } : {}), ...(provider.name ? { provider: provider.name } : {}),
    }, agent.id);
    const commonDir = await gitCommonDir(project.repo);
    const spec: SessionSpec = {
      sessionId, worktree: ws.worktree, gitCommonDir: commonDir, configDir: ws.configDir,
      ports: ws.ports, env: ws.env, secrets: ws.secrets, auth: provider.auth,
      tools: tools ?? harnessTools({
        view: this.view(ws.projectId), agentId: agent.id, taskId: ws.taskId,
        send: async (name, args) => (await this.link!.command(ws.projectId, name, args, agent.id)).result,
      }),
      instructions: sessionInstructions({ agentName: agent.name, taskId: ws.taskId, ports: ws.ports, repo: readRepoInstructions(ws.worktree) }),
      ...(provider.model ? { model: provider.model } : {}),
      ...(this.config.agents.maxBudgetUsd ? { maxBudgetUsd: this.config.agents.maxBudgetUsd } : {}),
      log: this.vendorLog(sessionId),
      // Reads stay in the worktree (D-61, D-98): the home directory, harness state and main checkout are denied.
      readPolicy: readPolicyFor({
        home: os.homedir(), harnessRoot: this.home.root, repo: project.repo, worktree: ws.worktree, gitCommonDir: commonDir,
        readAllow: this.config.agents.readAllow, pathEnv: process.env.PATH ?? '', tmpdir: os.tmpdir(),
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
      sync: { held: [], pending: false, running: null, blocked: null }, done: Promise.resolve(),
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

  /** The worktree diff itself. `afterSync`: wait for a running sync first (its merge holds the index); a sync calls it with false. */
  diffNow(run: RunningAgent, afterSync = false): Promise<void> {
    const next = (run.diff.running ?? Promise.resolve()).then(async () => {
      if (afterSync) await run.sync.running;
      try {
        const paths = this.reportablePaths(run, await changedPaths(run.workspace.worktree, this.project(run.projectId).baseBranch));
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
      case 'usage':
        run.lastUsage = o;
        break;
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
      case 'error':
        // Pause and alert; the vendor CLI does its own bounded retries, harnessd never loops (F-65).
        this.log(`${run.agent.name} (${run.taskId}): ${o.error}: ${o.message}`);
        break;
      case 'ended': {
        Object.assign(run.record, { pid: null, endedAt: new Date().toISOString(), endReason: o.reason });
        this.sessions.save(run.record);
        // The final running totals too: a session stopped mid-turn (budget, kill, hardening) never got its turn-end report (M8).
        const u = run.lastUsage;
        await report({
          status: 'ended', reason: o.reason,
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
      const base = await git(run.workspace.worktree, 'merge-base', 'HEAD', this.project(run.projectId).baseBranch);
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
      await this.waitForApproval(project.id, hash);
      await report('approved');
    }
    const logFile = path.join(this.home.logs, `setup-${project.id}-${taskId}.log`);
    const result = await runSetup({
      home: this.home, worktree, gitCommonDir: await gitCommonDir(project.repo), scratch: path.join(this.home.scratch, project.id, scratchName),
      command: setup.command, allowedDomains: this.config.setup.allowedDomains, timeoutMs: this.config.setup.timeoutSeconds * 1000, logFile,
    });
    if (result.exitCode !== 0) {
      await report('failed', { exit_code: result.exitCode });
      throw new Error(`setup command failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}); see ${logFile}`);
    }
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
