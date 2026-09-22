import type { Message } from "@mp/protocol";
import { ROOM_THREAD_ID, type RoomState } from "@mp/room";

export const MAX_DELIVERED = 1000;

function addressedTo(state: RoomState, m: Message, agentId: string): boolean {
  if (m.from.type === "agent" && m.from.id === agentId) return false;
  if (m.to.some((r) => r.type === "agent" && r.id === agentId)) return true;
  const thread = state.threads.get(m.threadId);
  if (!thread) return false;
  if (thread.id === ROOM_THREAD_ID || thread.kind === "room") return m.urgent === true;
  return thread.participants.some((p) => p.type === "agent" && p.id === agentId);
}

/**
 * Messages this agent should see and hasn't been handed yet: anything addressed to it, anything in
 * a thread it's part of, and urgent room-wide broadcasts. History from before the agent joined is skipped.
 */
export function pendingMessages(state: RoomState, agentId: string, delivered: ReadonlySet<string>): Message[] {
  const since = state.agents.get(agentId)?.startedAt ?? 0;
  return [...state.messages.values()]
    .filter((m) => m.createdAt >= since && !delivered.has(m.id) && addressedTo(state, m, agentId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function markDelivered(delivered: string[], ids: readonly string[]): string[] {
  const next = [...delivered, ...ids.filter((id) => !delivered.includes(id))];
  return next.length > MAX_DELIVERED ? next.slice(next.length - MAX_DELIVERED) : next;
}
