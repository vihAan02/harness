import type { Conflict, LockHolder, Message, StatusRow, Vendor } from "@mp/protocol";
import type { RoomState } from "@mp/room";

const VENDOR: Record<Vendor, string> = { claude: "Claude", codex: "Codex" };

export function vendorName(v: Vendor): string {
  return VENDOR[v];
}

/** `Sam's auth-refactor (Claude)` */
export function agentLabel(state: RoomState, agentId: string): string {
  const agent = state.agents.get(agentId);
  if (!agent) return agentId;
  const owner = state.members.get(agent.memberId)?.name ?? "someone";
  return `${owner}'s ${agent.name} (${VENDOR[agent.vendor]})`;
}

export function actorLabel(state: RoomState, ref: { type: "agent" | "member"; id: string }): string {
  return ref.type === "agent" ? agentLabel(state, ref.id) : (state.members.get(ref.id)?.name ?? ref.id);
}

function holderLine(h: LockHolder, state: RoomState): string {
  const agent = state.agents.get(h.agentId);
  const who = `${h.memberName}'s ${h.agentName}${agent ? ` (${VENDOR[agent.vendor]}, id ${h.agentId})` : ` (id ${h.agentId})`}`;
  const plan = h.planTitle ? ` working on "${h.planTitle}"${h.activeStep ? `, current step "${h.activeStep}"` : ""}` : "";
  return `- ${h.path} is being edited by ${who}${plan}.`;
}

export function formatLockDenial(held: LockHolder[], state: RoomState): string {
  const first = held[0];
  return [
    "Blocked by the multiplayer room: another agent has unlanded changes to this file.",
    ...held.map((h) => holderLine(h, state)),
    "",
    "Editing it now would cause a merge conflict. Instead:",
    first ? `- ask them: mp_ask with agentId "${first.agentId}" and your question` : "- ask the holder with mp_ask",
    first ? `- ask them to make the change for you: mp_handoff with agentId "${first.agentId}"` : "- request a handoff with mp_handoff",
    "- or continue with other parts of your plan and come back later.",
  ].join("\n");
}

export const PLAN_REQUIRED = [
  "Blocked by the multiplayer room: publish your plan before your first edit.",
  "Call mp_plan with a title, a short summary, your steps, and the paths you expect to touch.",
  "Other agents and teammates see it live, which is how the room avoids collisions.",
  "Then call mp_claim for the directories you will own, and retry this edit.",
].join("\n");

export function formatConflict(c: Conflict, state: RoomState): string {
  switch (c.kind) {
    case "collision":
      return `${c.path}: also changed by ${c.with.map((id) => agentLabel(state, id)).join(", ")}${c.overlappingLines ? " (same lines)" : ""}`;
    case "in_foreign_claim":
      return `${c.path} is in ${agentLabel(state, c.owner)}'s claimed area ${c.claimPattern}`;
    case "claim_overlap":
      return `claim ${c.pattern} overlaps ${agentLabel(state, c.with)}'s ${c.otherPattern}`;
    case "review":
      return `${c.role === "requester" ? "waiting on review" : "asked to review"} of \`${c.command}\` (${c.status})`;
    case "frozen":
      return `paused by review ${c.reviewId}: ${c.paths.slice(0, 3).join(", ")}${c.paths.length > 3 ? "…" : ""}`;
  }
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ") || "—";
}

/** The "What is everyone doing?" table, as Markdown. */
export function formatStatusTable(rows: StatusRow[], state: RoomState): string {
  if (!rows.length) return "Nobody is working in this room yet.";
  const header = "| Agent | Current task | Plan | Claimed directories | Files being modified | Conflicts |";
  const sep = "|---|---|---|---|---|---|";
  const lines = rows.map((r) => {
    const agent = `${r.agent.name} (${VENDOR[r.agent.vendor]} · ${r.agent.owner} · ${r.agent.status})`;
    const plan = r.plan
      ? `${r.plan.title}: ${r.plan.done}/${r.plan.total}${r.plan.activeStep ? `, now: ${r.plan.activeStep}` : ""}`
      : "no plan yet";
    const files = r.filesBeingModified
      .slice(0, 8)
      .map((f) => `${f.path} +${f.additions}/-${f.deletions}${f.locked ? " (locked)" : ""}`)
      .join(", ");
    const more = r.filesBeingModified.length > 8 ? ` and ${r.filesBeingModified.length - 8} more` : "";
    const conflicts = r.conflicts.map((c) => formatConflict(c, state)).join("; ");
    return `| ${[agent, r.currentTask ?? "", plan, r.claimedDirectories.join(", "), files + more, conflicts].map(cell).join(" | ")} |`;
  });
  return [header, sep, ...lines].join("\n");
}

export function formatInbox(messages: Message[], state: RoomState): string {
  const lines = messages.map((m) => {
    const from = actorLabel(state, m.from);
    const kind = m.kind === "chat" ? "message" : m.kind;
    const reply =
      m.kind === "question" || m.kind === "handoff"
        ? ` Reply with mp_answer (messageId "${m.id}").`
        : "";
    return `- [${kind}${m.urgent ? ", urgent" : ""}] from ${from}: ${m.body}${reply}`;
  });
  return ["Messages for you from the multiplayer room:", ...lines].join("\n");
}
