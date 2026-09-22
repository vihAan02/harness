import type { AgentEvent, RoomEvent, RoomSnapshot } from "@mp/protocol";
import { DEFAULT_OPTIONS } from "./engine.ts";
import { emptyState, snapshotOf, stateFromSnapshot, type RoomState } from "./state.ts";
import { computeStatus } from "./status.ts";

export interface MirrorOptions {
  maxStreamPerAgent: number;
  maxMessagesPerThread: number;
}

export class SeqGapError extends Error {
  readonly expected: number;
  readonly got: number;
  constructor(expected: number, got: number) {
    super(`event seq gap: expected ${expected}, got ${got}`);
    this.expected = expected;
    this.got = got;
  }
}

/**
 * A read-only replica of a room, kept current by applying the relay's events in order.
 * Daemons and the IDE use it for instant reads; all writes still go through the relay.
 *
 * Fields the relay changes without an event (lock `renewedAt`, heartbeat `lastSeenAt`) may lag.
 */
export class RoomMirror {
  state: RoomState;
  readonly opts: MirrorOptions;

  constructor(roomId: string, opts: Partial<MirrorOptions> = {}) {
    this.state = emptyState(roomId);
    this.opts = {
      maxStreamPerAgent: opts.maxStreamPerAgent ?? DEFAULT_OPTIONS.maxStreamPerAgent,
      maxMessagesPerThread: opts.maxMessagesPerThread ?? DEFAULT_OPTIONS.maxMessagesPerThread,
    };
  }

  get seq(): number {
    return this.state.seq;
  }

  reset(snapshot: RoomSnapshot): void {
    this.state = stateFromSnapshot(snapshot);
  }

  /** Applies one event. Throws SeqGapError if an event was missed (reconnect with lastSeq to recover). */
  apply(event: RoomEvent): void {
    if (event.seq <= this.state.seq) return; // duplicate
    if (event.seq !== this.state.seq + 1) throw new SeqGapError(this.state.seq + 1, event.seq);
    applyEvent(this.state, event, this.opts);
    this.state.seq = event.seq;
  }

  applyStream(agentId: string, events: AgentEvent[]): void {
    const buf = this.state.streams.get(agentId) ?? [];
    buf.push(...events);
    if (buf.length > this.opts.maxStreamPerAgent) buf.splice(0, buf.length - this.opts.maxStreamPerAgent);
    this.state.streams.set(agentId, buf);
  }

  status() {
    return computeStatus(this.state);
  }

  stateSnapshot(): RoomSnapshot {
    return snapshotOf(this.state);
  }
}

/** The pure reducer behind RoomMirror: mutates `state` to reflect `event`. */
export function applyEvent(state: RoomState, event: RoomEvent, opts: MirrorOptions): void {
  switch (event.type) {
    case "member.updated":
      state.members.set(event.member.id, event.member);
      return;
    case "agent.updated":
      state.agents.set(event.agent.id, event.agent);
      return;
    case "agent.removed":
      state.agents.delete(event.agentId);
      state.streams.delete(event.agentId);
      return;
    case "plan.updated":
      state.plans.set(event.plan.agentId, event.plan);
      return;
    case "plan.removed":
      state.plans.delete(event.agentId);
      return;
    case "claim.added":
      state.claims.set(event.claim.id, event.claim);
      return;
    case "claim.released":
      for (const id of event.claimIds) state.claims.delete(id);
      return;
    case "lock.acquired":
      for (const lock of event.locks) state.locks.set(lock.path, lock);
      return;
    case "lock.released":
      for (const p of event.paths) {
        if (state.locks.get(p)?.agentId === event.agentId) state.locks.delete(p);
      }
      return;
    case "diff.updated":
      state.diffs.set(event.diff.agentId, event.diff);
      return;
    case "diff.removed":
      state.diffs.delete(event.agentId);
      return;
    case "thread.opened":
      state.threads.set(event.thread.id, event.thread);
      return;
    case "message.posted": {
      const m = event.message;
      state.messages.set(m.id, m);
      const thread = state.threads.get(m.threadId);
      if (thread) {
        const participants = thread.kind === "room" || thread.participants.some((p) => p.type === m.from.type && p.id === m.from.id)
          ? thread.participants
          : [...thread.participants, m.from];
        state.threads.set(thread.id, { ...thread, participants, lastMessageAt: m.createdAt });
      }
      // Mirror the relay's per-thread trimming so replicas don't grow without bound.
      const inThread = [...state.messages.values()].filter((x) => x.threadId === m.threadId).sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 0; i < inThread.length - opts.maxMessagesPerThread; i++) state.messages.delete(inThread[i]!.id);
      return;
    }
    case "review.updated":
      state.reviews.set(event.review.id, event.review);
      return;
    case "freeze.set":
      state.freezes.set(event.freeze.id, event.freeze);
      return;
    case "freeze.cleared":
      state.freezes.delete(event.freezeId);
      return;
  }
}
