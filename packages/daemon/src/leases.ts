// harnessd's side of hard claims (0B item 5; contract D-97):
//  - renew the leases of each task this device ran, about every ttl/3, until the task is landed or
//    abandoned (not only while its session lives), so a finished task waiting to land keeps them. A
//    device that sleeps stops renewing, so its leases expire: that's the point (coordination §1);
//  - present the task's leases to the land step's fencing check, which the server decides (D-93);
//  - a fault switch that suspends renewal for one task, for T-2.
// Renewal is scheduled on this device's clock alone: a third of the lease's TTL after this device received
// its grant or its last renewal, never by comparing the server's expiry with the local clock (D-97, F-84).
// After a restart each lease is renewed once at once (when it was last renewed isn't known), then on schedule.
import type { LeaseInfo, ProjectView } from './view.ts';

export type LeaseFaults = {
  /** Test-only (T-2): while this returns true for a task, its leases aren't renewed. */
  suspendRenewal?: (taskId: string) => boolean;
};

export type LeaseKeeperOptions = {
  view: (projectId: string) => ProjectView;
  /** Sends a command for an agent, as harnessd does for its sessions. Resolves with the command's result. */
  send: (projectId: string, name: string, args: Record<string, unknown>, asAgent: string) => Promise<unknown>;
  log: (msg: string) => void;
  /** Renew every held lease this often (tests). Default: each lease a third of the way through its TTL (D-97). */
  renewMs?: number;
  faults?: LeaseFaults;
  /** This device, and its projects: at start, the tasks it ran are picked up again. */
  deviceId?: string;
  projects?: () => string[];
  /** The local clock, injectable for tests. */
  now?: () => number;
};

/** How often the keeper looks, when it renews each lease on its own schedule. */
const CHECK_MS = 1000;
/** One lease.renew takes at most this many ids (protocol §4). */
const BATCH = 200;
const DEFAULT_TTL_S = 120;
const ENDED = new Set(['landed', 'abandoned']);

export class LeaseKeeper {
  o: LeaseKeeperOptions;
  tracked = new Map<string, { projectId: string; agentId: string }>(); // by task
  /** By lease: when it's next due, on this device's clock. A lease not here yet is new to this keeper. */
  dueAt = new Map<string, number>();
  /** By task: consecutive failed renewals, for backoff. */
  failures = new Map<string, number>();
  timer: NodeJS.Timeout | null = null;
  busy = false;

  constructor(o: LeaseKeeperOptions) {
    this.o = o;
  }

  now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** harnessd has replayed each project's log: pick up the tasks this device ran that aren't landed or abandoned. */
  start(): void {
    for (const projectId of this.o.deviceId && this.o.projects ? this.o.projects() : []) {
      const view = this.o.view(projectId);
      for (const t of view.tasks.values()) {
        if (ENDED.has(t.status) || !t.assignee) continue;
        const last = [...view.sessions.values()].filter((s) => s.taskId === t.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
        if (last?.deviceId !== this.o.deviceId) continue;
        this.track(projectId, t.id, t.assignee);
        // When these were last renewed isn't known after a restart, so each is renewed once at once.
        for (const l of this.renewable(view, t.id)) this.dueAt.set(l.id, this.now());
      }
    }
    this.timer ??= setInterval(() => void this.tick(), this.o.renewMs ?? CHECK_MS);
  }

  /** This device runs `taskId` for `agentId`: keep its leases renewed until it's landed or abandoned. */
  track(projectId: string, taskId: string, agentId: string): void {
    this.tracked.set(taskId, { projectId, agentId });
  }

  /** The task is landed or abandoned: stop renewing its leases. */
  untrack(taskId: string): void {
    this.tracked.delete(taskId);
    this.failures.delete(taskId);
  }

  /**
   * The task's leases for the land step's fencing check (D-93, D-97): every lease it was granted and didn't
   * release, expired ones included. Whether one is still current is the server's call, on its clock, not
   * this device's; a stale holder presents its old token and the check rejects it (T-2).
   */
  tokens(projectId: string, taskId: string): { lease_id: string; token: number }[] {
    return [...this.o.view(projectId).leases.values()].filter((l) => l.taskId === taskId && !l.releasedAt).map((l) => ({ lease_id: l.id, token: l.token }));
  }

  /** harnessd is stopping: no more renewals. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Leases worth renewing: not released, and not known to have expired (a lost lease is never revived). */
  renewable(view: ProjectView, taskId: string): LeaseInfo[] {
    return [...view.leases.values()].filter((l) => l.taskId === taskId && !l.releasedAt && !l.expiredAt);
  }

  ttlMs(l: LeaseInfo): number {
    return (l.ttlS ?? DEFAULT_TTL_S) * 1000;
  }

  /** Due on a fixed `renewMs`, or once a third of its TTL has passed since this device last heard of it. */
  due(l: LeaseInfo, now: number): boolean {
    if (this.o.renewMs) return true;
    if (!this.dueAt.has(l.id)) this.dueAt.set(l.id, now + this.ttlMs(l) / 3); // just received: its grant
    return this.dueAt.get(l.id)! <= now;
  }

  async tick(): Promise<void> {
    if (this.busy) return; // a slow server: never two renewals at once
    this.busy = true;
    try {
      for (const [taskId, t] of [...this.tracked]) {
        const view = this.o.view(t.projectId);
        const task = view.tasks.get(taskId);
        if (!task || ENDED.has(task.status)) { this.untrack(taskId); continue; }
        if (this.o.faults?.suspendRenewal?.(taskId)) continue;
        const leases = this.renewable(view, taskId);
        const now = this.now();
        if (!leases.map((l) => this.due(l, now)).some(Boolean)) continue;
        await this.renew(t.projectId, taskId, t.agentId, leases);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Renews all of a task's held leases together, in batches the server accepts, and schedules each from the reply. */
  async renew(projectId: string, taskId: string, agentId: string, leases: LeaseInfo[]): Promise<void> {
    // Back off after failed rounds: 1 s, 2 s, 4 s … but never past a third of the shortest TTL, so a brief outage costs nothing.
    const round = (this.failures.get(taskId) ?? 0) + 1;
    const wait = Math.min(1000 * 2 ** (round - 1), Math.min(...leases.map((l) => this.ttlMs(l))) / 3);
    let failed = false;
    for (let i = 0; i < leases.length; i += BATCH) {
      const batch = leases.slice(i, i + BATCH);
      try {
        const r = await this.o.send(projectId, 'lease.renew', { lease_ids: batch.map((l) => l.id) }, agentId) as { renewed?: { lease_id: string }[]; lost?: { lease_id: string; reason: string }[] };
        const received = this.now();
        for (const x of r?.renewed ?? []) {
          const l = batch.find((b) => b.id === x.lease_id);
          if (l) this.dueAt.set(l.id, received + this.ttlMs(l) / 3);
        }
        for (const x of r?.lost ?? []) {
          this.dueAt.delete(x.lease_id);
          this.o.log(`${taskId}: lease ${x.lease_id} was lost (${x.reason}); it isn't renewed again`);
        }
      } catch (e) {
        failed = true;
        for (const l of batch) this.dueAt.set(l.id, this.now() + wait);
        this.o.log(`${taskId}: renewing ${batch.length} lease(s) failed (${(e as Error).message}); retrying in ${Math.round(wait / 1000)} s`);
      }
    }
    if (failed) this.failures.set(taskId, round);
    else this.failures.delete(taskId);
  }
}
