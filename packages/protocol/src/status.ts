import type { AgentStatus, ReviewStatus, Vendor } from "./entities.ts";

/** Something that makes an agent's work collide with another agent's. */
export type Conflict =
  /** Both agents have live changes to the same file. */
  | { kind: "collision"; path: string; with: string[]; overlappingLines: boolean }
  /** This agent's live changes are inside another agent's claimed area. */
  | { kind: "in_foreign_claim"; path: string; claimPattern: string; owner: string }
  /** Two agents claimed overlapping areas. */
  | { kind: "claim_overlap"; pattern: string; otherPattern: string; with: string }
  /** The agent is part of an open critical-command review. */
  | { kind: "review"; reviewId: string; role: "requester" | "affected"; status: ReviewStatus; command: string }
  /** A review has frozen some of this agent's work. */
  | { kind: "frozen"; reviewId: string; paths: string[] };

/** One row of "What is everyone doing?". */
export interface StatusRow {
  agent: {
    id: string;
    name: string;
    vendor: Vendor;
    status: AgentStatus;
    owner: string;
    deviceId: string;
    branch?: string;
  };
  currentTask: string | null;
  plan: {
    title: string;
    done: number;
    total: number;
    activeStep: string | null;
  } | null;
  claimedDirectories: string[];
  filesBeingModified: { path: string; additions: number; deletions: number; locked: boolean }[];
  conflicts: Conflict[];
}
