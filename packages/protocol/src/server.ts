import type { AgentEvent } from "./agent-events.ts";
import type {
  Agent,
  Claim,
  Freeze,
  LiveDiff,
  Lock,
  Member,
  Message,
  Plan,
  Review,
  Thread,
} from "./entities.ts";

export type LockReleaseReason = "released" | "expired" | "clean" | "override" | "agent_removed";

/** State-changing events. Every one gets a room-wide, gap-free `seq`. */
export type RoomEventBody =
  | { type: "member.updated"; member: Member }
  | { type: "agent.updated"; agent: Agent }
  | { type: "agent.removed"; agentId: string }
  | { type: "plan.updated"; plan: Plan }
  | { type: "plan.removed"; agentId: string }
  | { type: "claim.added"; claim: Claim }
  | { type: "claim.released"; agentId: string; claimIds: string[] }
  | { type: "lock.acquired"; agentId: string; locks: Lock[] }
  | { type: "lock.released"; agentId: string; paths: string[]; reason: LockReleaseReason }
  | { type: "diff.updated"; diff: LiveDiff }
  | { type: "diff.removed"; agentId: string }
  | { type: "thread.opened"; thread: Thread }
  | { type: "message.posted"; message: Message }
  | { type: "review.updated"; review: Review }
  | { type: "freeze.set"; freeze: Freeze }
  | { type: "freeze.cleared"; freezeId: string; reviewId: string };

export type RoomEventType = RoomEventBody["type"];

export type RoomEvent = RoomEventBody & {
  seq: number;
  at: number;
  /** Member whose op caused the event; null for relay-initiated events (expiry, presence). */
  by: string | null;
};

export interface RoomSnapshot {
  roomId: string;
  seq: number;
  members: Member[];
  agents: Agent[];
  plans: Plan[];
  claims: Claim[];
  locks: Lock[];
  diffs: LiveDiff[];
  threads: Thread[];
  messages: Message[];
  reviews: Review[];
  freezes: Freeze[];
  streams: Record<string, AgentEvent[]>;
}

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "internal";

export interface OpError {
  code: ErrorCode;
  message: string;
}

export interface LockHolder {
  path: string;
  agentId: string;
  agentName: string;
  memberName: string;
  planTitle?: string;
  activeStep?: string;
}

export type LockAcquireResult =
  | { granted: true; paths: string[] }
  | { granted: false; held: LockHolder[]; frozenBy?: undefined }
  | { granted: false; held: LockHolder[]; frozenBy: { reviewId: string; freezeId: string } };

export type ServerMsg =
  | {
      t: "welcome";
      roomId: string;
      memberId: string;
      seq: number;
      /** Replay: `events` are everything after the client's lastSeq. Snapshot: full state. */
      mode: "replay" | "snapshot";
      events?: RoomEvent[];
      snapshot?: RoomSnapshot;
      /** On replay, the tail of each agent's stream so live views can resume. */
      streamTails?: Record<string, AgentEvent[]>;
    }
  | { t: "event"; event: RoomEvent }
  /** Ephemeral: stream entries are not part of the seq'd event log. */
  | { t: "stream"; agentId: string; events: AgentEvent[] }
  | { t: "ack"; reqId: string; ok: true; result?: unknown }
  | { t: "ack"; reqId: string; ok: false; error: OpError }
  | { t: "error"; error: OpError };
