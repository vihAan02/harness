// harnessd v0 (0A item 4; docs/local-runtime.md). The per-device execution and security boundary
// (D-32): it prepares and tears down task workspaces, owns their Git writes, runs approved setup
// commands sandboxed, hands out ports and agent config dirs, tracks agent processes, and keeps a
// connection to the coordination server. It runs agent sessions only through @harness/adapters
// (D-17). Acting on task assignments arrives with the lifecycle (item 9).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter, type AgentAdapter, type Auth, type HarnessTool, type Observation, type SessionHandle, type SessionSpec } from '@harness/adapters';
import type { EventMessage } from '@harness/protocol';
import { Approvals, setupHash } from './approvals.ts';
import { loadConfig, resolveSecrets, type LocalConfig, type ProjectConfig } from './config.ts';
import { changedPaths, commitAll, createWorktree, gitCommonDir, removeWorktree, TASK_ID } from './git.ts';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';
import { ServerLink } from './link.ts';
import { effectivePolicy, readRepoConfig, type RepoConfig } from './repo-config.ts';
import { agentConfigDir, PortAllocator, portEnv, type PortBlock } from './resources.ts';
import { runSetup } from './setup.ts';
import { renderTask, type TaskForAgent } from './envelope.ts';
import { readRepoInstructions, sessionInstructions } from './instructions.ts';
import { killOrphans, processStart, Sessions, type OrphanReport, type SessionRecord } from './supervision.ts';
import { harnessTools } from './tools.ts';
import { ProjectView } from './view.ts';

export type TaskWorkspace = {
  projectId: string; taskId: string; worktree: string; branch: string;
  ports: PortBlock; configDir: string; env: Record<string, string>;
};
export type AgentRef = { id: string; name: string; vendor: string };
/** One agent session harnessd is running for a task. */
export type RunningAgent = {
  sessionId: string; projectId: string; taskId: string; agent: AgentRef; workspace: TaskWorkspace;
  adapter: AgentAdapter; handle: SessionHandle; record: SessionRecord;
  lastUsage: Extract<Observation, { kind: 'usage' }> | null;
  /** Observed-claim reconciliation (D-70): the last full set reported, and whether hooks reported since. */
  diff: { last: string | null; hooksSince: boolean; running: Promise<void> | null; timer: NodeJS.Timeout | null }; // running: the queue of diffs
  done: Promise<void>;
};
export type DaemonOptions = {
  home: Home; config?: LocalConfig;
  log?: (msg: string) => void; onEvent?: (e: EventMessage) => void;
  onObservation?: (run: RunningAgent, o: Observation) => void;
  heartbeatMs?: number; approvalPollMs?: number;
  /** How often a running agent's worktree is diffed for edits the hooks missed (D-70). Default 15 s; also at every turn end. */
  diffIntervalMs?: number;
  /** The vendor credential. Default: ANTHROPIC_API_KEY from harnessd's environment, passed through untouched (D-48, D-56). */
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
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.running.keys()].map((taskId) => this.stopAgent(taskId)));
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
    const env = { ...portEnv(ports), ...resolveSecrets(this.home, policy.secretNames) };
    return { projectId: t.projectId, taskId: t.taskId, worktree, branch, ports, configDir, env };
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
    const auth = this.auth();
    const sessionId = randomUUID();
    const record: SessionRecord = {
      sessionId, agentId: agent.id, taskId: ws.taskId, projectId: ws.projectId, worktree: ws.worktree, baseBranch: project.baseBranch,
      pid: null, pidStart: null, configDir: ws.configDir, startedAt: new Date().toISOString(), vendor: agent.vendor,
    };
    this.sessions.save(record);
    await this.report(ws.projectId, 'session.report', {
      session_id: sessionId, status: 'starting', task_id: ws.taskId, worktree: ws.worktree, branch: ws.branch,
    }, agent.id);
    const spec: SessionSpec = {
      sessionId, worktree: ws.worktree, gitCommonDir: await gitCommonDir(project.repo), configDir: ws.configDir,
      ports: ws.ports, env: ws.env, auth,
      tools: tools ?? harnessTools({
        view: this.view(ws.projectId), agentId: agent.id, taskId: ws.taskId,
        send: async (name, args) => (await this.link!.command(ws.projectId, name, args, agent.id)).result,
      }),
      instructions: sessionInstructions({ agentName: agent.name, taskId: ws.taskId, ports: ws.ports, repo: readRepoInstructions(ws.worktree) }),
      ...(this.config.agents.model ? { model: this.config.agents.model } : {}),
      ...(this.config.agents.maxBudgetUsd ? { maxBudgetUsd: this.config.agents.maxBudgetUsd } : {}),
      log: this.vendorLog(sessionId),
    };
    const handle = await adapter.startSession(spec, { id: `task:${ws.taskId}`, origin: 'human', text: renderTask(task) });
    const run: RunningAgent = {
      sessionId, projectId: ws.projectId, taskId: ws.taskId, agent, workspace: ws, adapter, handle, record, lastUsage: null,
      diff: { last: null, hooksSince: false, running: null, timer: null }, done: Promise.resolve(),
    };
    this.running.set(ws.taskId, run);
    run.diff.timer = setInterval(() => void this.reconcile(run), this.o.diffIntervalMs ?? 15_000);
    run.done = this.watch(run);
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

  auth(): Auth {
    if (this.o.auth) return this.o.auth;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('set ANTHROPIC_API_KEY for harnessd: agents run on an API key, never a subscription login (D-56)');
    return { mode: 'api-key', apiKey };
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
        const paths = await changedPaths(run.workspace.worktree, this.project(run.projectId).baseBranch);
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
        await report({ status: run.adapter.getStatus(run.handle), vendor_session_id: o.vendorSessionId, vendor_version: o.vendorVersion });
        break;
      case 'status':
        if (o.status !== 'ended') await report({ status: o.status });
        break;
      case 'usage':
        run.lastUsage = o;
        break;
      case 'edit.observed':
        if (o.outside.length) this.log(`${run.agent.name} (${run.taskId}): edit outside its worktree reported: ${o.outside.join(', ')}`);
        if (o.paths.length) {
          run.diff.hooksSince = true;
          await this.report(run.projectId, 'claim.observe', { session_id: run.sessionId, paths: o.paths, source: 'hook' }, run.agent.id);
        }
        break;
      case 'turn.ended':
        await this.reconcile(run);
        if (run.lastUsage) {
          const u = run.lastUsage;
          await report({
            status: run.adapter.getStatus(run.handle),
            usage: { input: u.input, output: u.output, cache_read: u.cacheRead, cache_creation: u.cacheCreation, cost_usd: u.costUsd },
          });
        }
        break;
      case 'error':
        // Pause and alert; the vendor CLI does its own bounded retries, harnessd never loops (F-65).
        this.log(`${run.agent.name} (${run.taskId}): ${o.error}: ${o.message}`);
        break;
      case 'ended':
        Object.assign(run.record, { pid: null, endedAt: new Date().toISOString(), endReason: o.reason });
        this.sessions.save(run.record);
        await report({ status: 'ended', reason: o.reason });
        break;
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
