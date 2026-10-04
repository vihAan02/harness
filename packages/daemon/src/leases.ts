// harnessd's side of hard claims (0B item 5; contract D-97). Stream B builds it here (D-94):
//  - renew the leases of each task this device ran, about every ttl/3, until the task is landed or
//    abandoned (not only while its session lives), so a finished task waiting to land keeps them;
//  - present the task's current leases to the land step's fencing check;
//  - a fault switch that suspends renewal, for T-2.
// Until then it tracks nothing and presents no tokens, exactly as before.
import type { ProjectView } from './view.ts';

export type LeaseFaults = {
  /** Test-only (T-2): while this returns true for a task, its leases aren't renewed. */
  suspendRenewal?: (taskId: string) => boolean;
};

export type LeaseKeeperOptions = {
  view: (projectId: string) => ProjectView;
  /** Sends a command for an agent, as harnessd does for its sessions. Resolves with the command's result. */
  send: (projectId: string, name: string, args: Record<string, unknown>, asAgent: string) => Promise<unknown>;
  log: (msg: string) => void;
  /** How often to renew. Default: about a third of each lease's TTL (D-97). */
  renewMs?: number;
  faults?: LeaseFaults;
};

export class LeaseKeeper {
  o: LeaseKeeperOptions;

  constructor(o: LeaseKeeperOptions) {
    this.o = o;
  }

  /** harnessd has replayed each project's log: pick up the tasks this device ran that aren't landed or abandoned. */
  start(): void {}

  /** This device runs `taskId` for `agentId`: keep its leases renewed until it's landed or abandoned. */
  track(_projectId: string, _taskId: string, _agentId: string): void {}

  /** The task is landed or abandoned: stop renewing its leases. */
  untrack(_taskId: string): void {}

  /** The task's current leases, as the land step presents them for the fencing check (D-93, D-97). */
  tokens(_projectId: string, _taskId: string): { lease_id: string; token: number }[] {
    return [];
  }

  /** harnessd is stopping: no more renewals. */
  stop(): void {}
}
