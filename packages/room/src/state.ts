import type {
  Agent,
  AgentEvent,
  Claim,
  Freeze,
  LiveDiff,
  Lock,
  Member,
  Message,
  Plan,
  Review,
  RoomSnapshot,
  Thread,
} from "@mp/protocol";

export interface CollectionTypes {
  members: Member;
  agents: Agent;
  /** Keyed by agentId. */
  plans: Plan;
  claims: Claim;
  /** Keyed by repo-relative path. */
  locks: Lock;
  /** Keyed by agentId. */
  diffs: LiveDiff;
  threads: Thread;
  messages: Message;
  reviews: Review;
  freezes: Freeze;
}

export type Collection = keyof CollectionTypes;

export const COLLECTIONS: readonly Collection[] = [
  "members",
  "agents",
  "plans",
  "claims",
  "locks",
  "diffs",
  "threads",
  "messages",
  "reviews",
  "freezes",
];

export type RoomState = { roomId: string; seq: number; streams: Map<string, AgentEvent[]> } & {
  [C in Collection]: Map<string, CollectionTypes[C]>;
};

/** A persistence delta. The relay writes these to SQLite; daemons can ignore them. */
export type Change =
  | { kind: "put"; collection: Collection; id: string; value: CollectionTypes[Collection] }
  | { kind: "del"; collection: Collection; id: string }
  | { kind: "stream.append"; agentId: string; events: AgentEvent[]; keep: number }
  | { kind: "stream.clear"; agentId: string };

export function keyOf<C extends Collection>(collection: C, value: CollectionTypes[C]): string {
  switch (collection) {
    case "plans":
    case "diffs":
      return (value as Plan | LiveDiff).agentId;
    case "locks":
      return (value as Lock).path;
    default:
      return (value as { id: string }).id;
  }
}

export function emptyState(roomId: string): RoomState {
  return {
    roomId,
    seq: 0,
    streams: new Map(),
    members: new Map(),
    agents: new Map(),
    plans: new Map(),
    claims: new Map(),
    locks: new Map(),
    diffs: new Map(),
    threads: new Map(),
    messages: new Map(),
    reviews: new Map(),
    freezes: new Map(),
  };
}

export function stateFromSnapshot(snap: RoomSnapshot): RoomState {
  const state = emptyState(snap.roomId);
  state.seq = snap.seq;
  for (const c of COLLECTIONS) {
    const map = state[c] as Map<string, CollectionTypes[typeof c]>;
    for (const v of snap[c] as CollectionTypes[typeof c][]) map.set(keyOf(c, v), v);
  }
  for (const [agentId, events] of Object.entries(snap.streams)) state.streams.set(agentId, [...events]);
  return state;
}

export function snapshotOf(state: RoomState): RoomSnapshot {
  return {
    roomId: state.roomId,
    seq: state.seq,
    members: [...state.members.values()],
    agents: [...state.agents.values()],
    plans: [...state.plans.values()],
    claims: [...state.claims.values()],
    locks: [...state.locks.values()],
    diffs: [...state.diffs.values()],
    threads: [...state.threads.values()],
    messages: [...state.messages.values()].sort((a, b) => a.createdAt - b.createdAt),
    reviews: [...state.reviews.values()],
    freezes: [...state.freezes.values()],
    streams: Object.fromEntries([...state.streams].map(([k, v]) => [k, [...v]])),
  };
}
