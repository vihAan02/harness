// harnessd v0 (0A item 4; docs/local-runtime.md). The per-device execution and security boundary
// (D-32): it prepares and tears down task workspaces, owns their Git writes, runs approved setup
// commands sandboxed, hands out ports and agent config dirs, tracks agent processes, and keeps a
// connection to the coordination server. Acting on task assignments arrives with the lifecycle
// (item 9), and running agents with the adapter (item 5).
import fs from 'node:fs';
import path from 'node:path';
import type { EventMessage } from '@harness/protocol';
import { Approvals, setupHash } from './approvals.ts';
import { loadConfig, resolveSecrets, type LocalConfig, type ProjectConfig } from './config.ts';
import { commitAll, createWorktree, gitCommonDir, removeWorktree, TASK_ID } from './git.ts';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';
import { ServerLink } from './link.ts';
import { effectivePolicy, readRepoConfig, type RepoConfig } from './repo-config.ts';
import { agentConfigDir, PortAllocator, portEnv, type PortBlock } from './resources.ts';
import { runSetup } from './setup.ts';
import { killOrphans, Sessions, type OrphanReport } from './supervision.ts';

export type TaskWorkspace = {
  projectId: string; taskId: string; worktree: string; branch: string;
  ports: PortBlock; configDir: string; env: Record<string, string>;
};
export type DaemonOptions = {
  home: Home; config?: LocalConfig;
  log?: (msg: string) => void; onEvent?: (e: EventMessage) => void;
  heartbeatMs?: number; approvalPollMs?: number;
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

  constructor(o: DaemonOptions) {
    this.o = o;
    this.home = o.home;
    this.config = o.config ?? loadConfig(o.home);
    this.log = o.log ?? (() => {});
    this.approvals = new Approvals(this.home);
    this.sessions = new Sessions(this.home);
    this.ports = new PortAllocator(this.home, this.config.limits.portRange, this.config.limits.portsPerAgent, this.config.limits.maxConcurrentAgents);
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
      onEvent: (e) => this.o.onEvent?.(e),
      onCursor: () => writeJsonAtomic(this.home.state, { cursors: this.link!.cursors }),
      ...(this.o.heartbeatMs ? { heartbeatMs: this.o.heartbeatMs } : {}),
      log: this.log,
    });
    this.link.start();
  }

  /** Resolves once the server has welcomed this daemon. */
  ready(): Promise<void> {
    if (!this.link) throw new Error('start() first');
    return this.link.whenReady();
  }

  async stop(): Promise<void> {
    this.stopping = true;
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

  // ---------- internals ----------

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

  async report(projectId: string, name: string, args: Record<string, unknown>): Promise<void> {
    if (!this.link) throw new Error('start() first');
    await this.link.command(projectId, name, args);
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
