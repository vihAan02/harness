// harnessd v0 (0A item 4; docs/local-runtime.md). The per-device execution and security boundary
// (D-32): it prepares and tears down task workspaces, owns their Git writes, runs approved setup
// commands sandboxed, hands out ports and agent config dirs, tracks agent processes, and keeps a
// connection to the coordination server. It runs agent sessions only through @harness/adapters
// (D-17). Acting on task assignments arrives with the lifecycle (item 9).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ClaudeAdapter, type AgentAdapter, type Auth, type HarnessTool, type Observation, type SessionHandle, type SessionSpec, type SessionStatus,
} from '@harness/adapters';
import type { EventMessage } from '@harness/protocol';
import { Approvals, setupHash } from './approvals.ts';
import { loadConfig, resolveSecrets, type LocalConfig, type ProjectConfig } from './config.ts';
import { branchTip, changedPaths, commitAll, createWorktree, gitCommonDir, removeWorktree, TASK_ID } from './git.ts';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';
import { ServerLink } from './link.ts';
import { effectivePolicy, readRepoConfig, type RepoConfig } from './repo-config.ts';
import { agentConfigDir, PortAllocator, portEnv, type PortBlock } from './resources.ts';
import { runSetup } from './setup.ts';
import { renderMessage, renderTask, type MessageForAgent, type TaskForAgent } from './envelope.ts';
import { readRepoInstructions, sessionInstructions } from './instructions.ts';
import { providerModel, providerName, resolveProvider, type ResolvedProvider } from './provider.ts';
import { killOrphans, processStart, Sessions, type OrphanReport, type SessionRecord } from './supervision.ts';
import { harnessTools } from './tools.ts';
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
  done: Promise<void>;
};
export type DaemonOptions = {
  home: Home; config?: LocalConfig;
  log?: (msg: string) => void; onEvent?: (e: EventMessage) => void;
  onObservation?: (run: RunningAgent, o: Observation) => void;
  heartbeatMs?: number; approvalPollMs?: number;
  /** After `task.completed`, how long to let the agent finish its turn before stopping it. Default 60 s. */
  finishGraceMs?: number;
  /** How often a running agent's worktree is diffed for edits the hooks missed (D-70). Default 15 s; also at every turn end. */
  diffIntervalMs?: number;
  /** The model endpoint and key. Default: resolved from the config and harnessd's environment (D-87); see provider.ts. */
  provider?: ResolvedProvider;
  /** Overrides only the endpoint and key (tests point it at a scripted mock); the model settings still come from the config. */
  auth?: Auth;
  adapters?: Record<string, AgentAdapter>;
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
      const run = m?.to ? [...this.running.values()].find((r) => r.projectId === e.project_id && r.agent.id === m.to) : undefined;
      if (m && run) void this.deliver(run, m);
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
      if (fs.existsSync(this.worktreeOf(project.id, taskId))) await this.teardownTask({ projectId: project.id, taskId });
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
    if (m.held || m.deliveredAt || this.delivering.has(m.id) || this.delivered.has(m.id)) return;
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

  /** Messages that arrived while the agent had no live session. */
  deliverPending(run: RunningAgent): void {
    const view = this.view(run.projectId);
    const pending = [...view.messages.values()].filter((m) => m.to === run.agent.id && !m.held && !m.deliveredAt).sort((a, b) => a.seq - b.seq);
    for (const m of pending) void this.deliver(run, m);
  }

  async stop(): Promise<void> {
    this.stopping = true;
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
    await this.report(t.projectId, 'worktree.report', { task_id: t.taskId, event: 'created', path: worktree, branch });

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

  /** Removes the worktree (and its branch, if merged), frees its ports and scratch space (local-runtime §3 step 7). */
  async teardownTask(t: { projectId: string; taskId: string }): Promise<{ branchDeleted: boolean }> {
    const project = this.project(t.projectId);
    const worktree = this.worktreeOf(t.projectId, t.taskId);
    const { branchDeleted } = await removeWorktree(project.repo, worktree, t.taskId);
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
    const spec: SessionSpec = {
      sessionId, worktree: ws.worktree, gitCommonDir: await gitCommonDir(project.repo), configDir: ws.configDir,
      ports: ws.ports, env: ws.env, secrets: ws.secrets, auth: provider.auth,
      tools: tools ?? harnessTools({
        view: this.view(ws.projectId), agentId: agent.id, taskId: ws.taskId,
        send: async (name, args) => (await this.link!.command(ws.projectId, name, args, agent.id)).result,
      }),
      instructions: sessionInstructions({ agentName: agent.name, taskId: ws.taskId, ports: ws.ports, repo: readRepoInstructions(ws.worktree) }),
      ...(provider.model ? { model: provider.model } : {}),
      ...(this.config.agents.maxBudgetUsd ? { maxBudgetUsd: this.config.agents.maxBudgetUsd } : {}),
      log: this.vendorLog(sessionId),
    };
    const handle = await adapter.startSession(spec, { id: `task:${ws.taskId}`, origin: 'human', text: renderTask(task) });
    const run: RunningAgent = {
      sessionId, projectId: ws.projectId, taskId: ws.taskId, agent, workspace: ws, adapter, handle, record, lastUsage: null, status: 'starting', tools: { calls: {}, denied: 0 },
      diff: { last: null, hooksSince: false, running: null, timer: null }, done: Promise.resolve(),
    };
    this.running.set(ws.taskId, run);
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
    this.running.delete(run.taskId);
  }

  /**
   * Reports the task's full set of changed files, from Git: what it changed since the merge base, plus
   * everything uncommitted (D-70). Catches background writes and edits whose hook failed open. Sent only
   * when the set changed, or hooks reported something since the last one.
   */
  reconcile(run: RunningAgent): Promise<void> {
    const next = (run.diff.running ?? Promise.resolve()).then(async () => {
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
        break;
      case 'edit.observed':
        if (o.outside.length) this.log(`${run.agent.name} (${run.taskId}): edit outside its worktree reported: ${o.outside.join(', ')}`);
        if (o.paths.length) {
          run.diff.hooksSince = true;
          const paths = this.reportablePaths(run, o.paths);
          if (paths.length) await this.report(run.projectId, 'claim.observe', { session_id: run.sessionId, paths, source: 'hook' }, run.agent.id);
        }
        break;
      case 'turn.ended': {
        await this.reconcile(run);
        run.tools.denied += o.denied;
        const u = run.lastUsage;
        await report({
          status: run.status,
          ...(u ? { usage: { input: u.input, output: u.output, cache_read: u.cacheRead, cache_creation: u.cacheCreation, cost_usd: u.costUsd, cost_basis: u.costBasis, models: u.models } } : {}),
          tools: { calls: { ...run.tools.calls }, denied: run.tools.denied },
        });
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
          tools: { calls: { ...run.tools.calls }, denied: run.tools.denied },
        });
        break;
      }
    }
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

  async runApprovedSetup(project: ProjectConfig, taskId: string, worktree: string, setup: NonNullable<RepoConfig['setup']>): Promise<void> {
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
      home: this.home, worktree, gitCommonDir: await gitCommonDir(project.repo), scratch: path.join(this.home.scratch, project.id, taskId),
      command: setup.command, allowedDomains: this.config.setup.allowedDomains, timeoutMs: this.config.setup.timeoutSeconds * 1000, logFile,
    });
    if (result.exitCode !== 0) {
      await report('failed', { exit_code: result.exitCode });
      throw new Error(`setup command failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}); see ${logFile}`);
    }
    await report('ran', { exit_code: 0 });
  }

  async waitForApproval(projectId: string, hash: string): Promise<void> {
    while (!this.approvals.isApproved(projectId, hash)) {
      if (this.stopping) throw new Error('harnessd stopped while waiting for approval');
      await new Promise((r) => setTimeout(r, this.o.approvalPollMs ?? 500));
    }
  }
}
