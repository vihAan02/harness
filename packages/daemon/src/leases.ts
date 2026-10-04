// harnessd's side of hard claims (0B item 5; contract D-97):
//  - renew the leases of each task this device ran, about every ttl/3, until the task is landed or
//    abandoned (not only while its session lives), so a finished task waiting to land keeps them. A
//    device that sleeps stops renewing, so its leases expire: that's the point (coordination §1);
//  - present the task's leases to the land step's fencing check, which the server decides (D-93);
//  - a fault switch that suspends renewal for one task, for T-2.
// It works from the project view, so a restarted harnessd picks up where it left off.
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
  /** Renew every lease this often. Default: each lease about a third of the way through its TTL (D-97). */
  renewMs?: number;
  faults?: LeaseFaults;
  /** This device, and its projects: at start, the tasks it ran are picked up again. */
  deviceId?: string;
  projects?: () => string[];
};

/** How often the keeper looks, when it renews each lease by its own TTL. */
const CHECK_MS = 1000;
const ENDED = new Set(['landed', 'abandoned']);

export class LeaseKeeper {
  o: LeaseKeeperOptions;
  tracked = new Map<string, { projectId: string; agentId: string }>(); // by task
  ttls = new Map<string, number>(); // by lease: its TTL, as first seen (expiry minus grant)
  timer: NodeJS.Timeout | null = null;
  busy = false;

  constructor(o: LeaseKeeperOptions) {
    this.o = o;
  }

  /** harnessd has replayed each project's log: pick up the tasks this device ran that aren't landed or abandoned. */
  start(): void {
    for (const projectId of this.o.deviceId && this.o.projects ? this.o.projects() : []) {
      const view = this.o.view(projectId);
      for (const t of view.tasks.values()) {
        if (ENDED.has(t.status) || !t.assignee) continue;
        const last = [...view.sessions.values()].filter((s) => s.taskId === t.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
        if (last?.deviceId === this.o.deviceId) this.track(projectId, t.id, t.assignee);
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
  }

  /** The task's leases that haven't ended, as the land step presents them for the fencing check (D-93, D-97). */
  tokens(projectId: string, taskId: string): { lease_id: string; token: number }[] {
    return this.held(this.o.view(projectId), taskId).map((l) => ({ lease_id: l.id, token: l.token }));
  }

  /** harnessd is stopping: no more renewals. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Leases of a task not released and not known to have expired. Whether they're current is the server's call (F-84). */
  held(view: ProjectView, taskId: string): LeaseInfo[] {
    return [...view.leases.values()].filter((l) => l.taskId === taskId && !l.releasedAt && !l.expiredAt);
  }

  /** Due when a third of its TTL has passed since it was last granted or renewed, or on every tick with a fixed `renewMs`. */
  due(l: LeaseInfo, now: number): boolean {
    if (this.o.renewMs) return true;
    if (!this.ttls.has(l.id)) this.ttls.set(l.id, Math.max(1000, Date.parse(l.expiresAt) - Date.parse(l.grantedAt)));
    return Date.parse(l.expiresAt) - now <= (this.ttls.get(l.id)! * 2) / 3;
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
        const leases = this.held(view, taskId);
        const now = Date.now();
        if (!leases.some((l) => this.due(l, now))) continue;
        try {
          const r = await this.o.send(t.projectId, 'lease.renew', { lease_ids: leases.map((l) => l.id) }, t.agentId) as { lost?: { lease_id: string; reason: string }[] };
          for (const x of r?.lost ?? []) this.o.log(`${taskId}: lease ${x.lease_id} was lost (${x.reason}); it isn't renewed again`);
        } catch (e) {
          this.o.log(`${taskId}: renewing its leases failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
