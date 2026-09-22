import { OPEN_REVIEW_STATUSES, type Conflict, type StatusRow } from "@mp/protocol";
import { hunksOverlap, matchesAny, matchesPattern, patternsOverlap } from "./paths.ts";
import type { RoomState } from "./state.ts";

export interface Collision {
  path: string;
  agentIds: string[];
  /** True when at least two agents' hunks touch the same or adjacent base lines. */
  overlappingLines: boolean;
}

/** Files with live changes from more than one agent. */
export function computeCollisions(state: RoomState): Collision[] {
  const byPath = new Map<string, { agentId: string; hunks: import("@mp/protocol").Hunk[] }[]>();
  for (const diff of state.diffs.values()) {
    for (const f of diff.files) {
      let list = byPath.get(f.path);
      if (!list) byPath.set(f.path, (list = []));
      list.push({ agentId: diff.agentId, hunks: f.hunks });
    }
  }
  const out: Collision[] = [];
  for (const [path, entries] of byPath) {
    if (entries.length < 2) continue;
    let overlappingLines = false;
    for (let i = 0; i < entries.length && !overlappingLines; i++) {
      for (let j = i + 1; j < entries.length && !overlappingLines; j++) {
        overlappingLines = hunksOverlap(entries[i]!.hunks, entries[j]!.hunks);
      }
    }
    out.push({ path, agentIds: entries.map((e) => e.agentId).sort(), overlappingLines });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Rows for "What is everyone doing?", one per agent, ordered by owner then agent name. */
export function computeStatus(state: RoomState): StatusRow[] {
  const collisions = computeCollisions(state);
  const claims = [...state.claims.values()];
  const reviews = [...state.reviews.values()].filter((r) => OPEN_REVIEW_STATUSES.includes(r.status));
  const freezes = [...state.freezes.values()];

  const rows: StatusRow[] = [];
  for (const agent of state.agents.values()) {
    const owner = state.members.get(agent.memberId)?.name ?? agent.memberId;
    const plan = state.plans.get(agent.id);
    const diff = state.diffs.get(agent.id);
    const myLocks = new Set([...state.locks.values()].filter((l) => l.agentId === agent.id).map((l) => l.path));
    const myClaims = claims.filter((c) => c.agentId === agent.id);

    const files = (diff?.files ?? []).map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      locked: myLocks.has(f.path),
    }));
    for (const p of myLocks) {
      if (!files.some((f) => f.path === p)) files.push({ path: p, additions: 0, deletions: 0, locked: true });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    const conflicts: Conflict[] = [];
    for (const c of collisions) {
      if (!c.agentIds.includes(agent.id)) continue;
      conflicts.push({
        kind: "collision",
        path: c.path,
        with: c.agentIds.filter((id) => id !== agent.id),
        overlappingLines: c.overlappingLines,
      });
    }
    for (const f of files) {
      for (const claim of claims) {
        if (claim.agentId !== agent.id && matchesPattern(claim.pattern, f.path)) {
          conflicts.push({ kind: "in_foreign_claim", path: f.path, claimPattern: claim.pattern, owner: claim.agentId });
        }
      }
    }
    for (const mine of myClaims) {
      for (const other of claims) {
        if (other.agentId !== agent.id && patternsOverlap(mine.pattern, other.pattern)) {
          conflicts.push({ kind: "claim_overlap", pattern: mine.pattern, otherPattern: other.pattern, with: other.agentId });
        }
      }
    }
    for (const r of reviews) {
      const role = r.requesterAgentId === agent.id ? "requester" : r.affectedAgentIds.includes(agent.id) ? "affected" : null;
      if (role) conflicts.push({ kind: "review", reviewId: r.id, role, status: r.status, command: r.command });
    }
    for (const f of freezes) {
      const review = state.reviews.get(f.reviewId);
      if (!review || !OPEN_REVIEW_STATUSES.includes(review.status) || review.requesterAgentId === agent.id) continue;
      if (f.scope !== "room" && !f.agentIds.includes(agent.id)) continue;
      const frozenPaths = files.map((x) => x.path).filter((p) => matchesAny(f.paths, p));
      conflicts.push({ kind: "frozen", reviewId: f.reviewId, paths: frozenPaths.length ? frozenPaths : f.paths });
    }

    const active = plan?.steps.find((s) => s.status === "active");
    rows.push({
      agent: {
        id: agent.id,
        name: agent.name,
        vendor: agent.vendor,
        status: agent.status,
        owner,
        deviceId: agent.deviceId,
        ...(agent.branch !== undefined ? { branch: agent.branch } : {}),
      },
      currentTask: agent.task ?? plan?.title ?? null,
      plan: plan
        ? {
            title: plan.title,
            done: plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length,
            total: plan.steps.length,
            activeStep: active?.text ?? null,
          }
        : null,
      claimedDirectories: myClaims.map((c) => c.pattern),
      filesBeingModified: files,
      conflicts,
    });
  }
  return rows.sort((a, b) => a.agent.owner.localeCompare(b.agent.owner) || a.agent.name.localeCompare(b.agent.name));
}
