import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HookDecision, LockAcquireResult } from "@mp/protocol";
import { matchesAny, matchesPattern } from "@mp/room";
import type { RepoConfig } from "./config.ts";
import { agentLabel, formatLockDenial, PLAN_REQUIRED } from "./format.ts";
import type { LocalAgent } from "./home.ts";
import { OfflineError, OpFailedError, type RoomLink } from "./link.ts";

export const OFFLINE_WARNING =
  "Note: the multiplayer room is unreachable right now, so this edit was not locked. " +
  "Other agents can't see it yet; it will sync when the connection returns.";

/** Resolves symlinks (e.g. macOS /var → /private/var) even for files that don't exist yet. */
export async function resolveReal(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(await resolveReal(parent), basename(p));
  }
}

export interface Checkout {
  /** Real path of a checkout that is not this agent's own. */
  path: string;
  label: string;
}

export interface ClassifiedPaths {
  /** Repo-relative POSIX paths inside the agent's own worktree. */
  inside: string[];
  /** Absolute paths inside another checkout of the same repo (the main checkout or another agent's worktree). */
  foreign: { path: string; label: string }[];
  /** Absolute paths outside any checkout we know (e.g. /tmp). */
  outside: string[];
}

function within(root: string, p: string): string | null {
  const rel = relative(root, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return rel === "" ? "" : null;
  return rel.split(sep).join("/");
}

export async function classifyPaths(
  worktree: string,
  rawPaths: readonly string[],
  others: readonly Checkout[],
): Promise<ClassifiedPaths> {
  const out: ClassifiedPaths = { inside: [], foreign: [], outside: [] };
  for (const raw of rawPaths) {
    const abs = await resolveReal(isAbsolute(raw) ? raw : join(worktree, raw));
    const rel = within(worktree, abs);
    if (rel !== null && rel !== "" && !rel.startsWith(".git/") && rel !== ".git") {
      if (!out.inside.includes(rel)) out.inside.push(rel);
      continue;
    }
    if (rel !== null) continue; // the worktree root itself or its .git — nothing to lock
    const other = others.find((o) => within(o.path, abs) !== null);
    if (other) out.foreign.push({ path: abs, label: other.label });
    else out.outside.push(abs);
  }
  return out;
}

export interface PolicyEnv {
  link: RoomLink;
  config: RepoConfig;
  agent: LocalAgent;
  others: readonly Checkout[];
  /** Claim ids this agent was already warned about. */
  warned: Set<string>;
  holdTimeoutMs: number;
  /** Re-registers the agent with the relay (after it was removed or the relay forgot it). */
  reregister: () => Promise<void>;
  /** Resolves true when the review's freezes are gone, false on timeout. */
  waitForFreezeClear: (reviewId: string, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
}

function withContext(decision: HookDecision, context: string[]): HookDecision {
  if (!context.length || decision.decision === "hold") return decision;
  const joined = [decision.additionalContext, ...context].filter(Boolean).join("\n\n");
  return { ...decision, additionalContext: joined };
}

/** Decides whether an edit to `rawPaths` may proceed. Holds (freezes) are resolved here, so the result is allow or deny. */
export async function decidePreEdit(env: PolicyEnv, rawPaths: readonly string[]): Promise<HookDecision> {
  const now = env.now ?? Date.now;
  const deadline = now() + env.holdTimeoutMs;
  const { agent, link, config } = env;
  const paths = await classifyPaths(agent.worktree, rawPaths, env.others);

  if (paths.foreign.length) {
    const f = paths.foreign[0]!;
    return {
      decision: "deny",
      reason:
        `You are working in your own worktree ${agent.worktree} (branch ${agent.branch}). ` +
        `${f.path} is in ${f.label}. Make this change inside your worktree instead, so it stays on your branch.`,
    };
  }
  if (!paths.inside.length) return { decision: "allow" };
  if (!link.connected) return { decision: "allow", additionalContext: OFFLINE_WARNING };

  const state = link.mirror.state;
  if (config.requirePlan && !state.plans.has(agent.id)) return { decision: "deny", reason: PLAN_REQUIRED };

  const context: string[] = [];
  for (const claim of state.claims.values()) {
    if (claim.agentId === agent.id || env.warned.has(claim.id)) continue;
    const hit = paths.inside.find((p) => matchesPattern(claim.pattern, p));
    if (hit) {
      env.warned.add(claim.id);
      context.push(
        `Heads up: ${hit} is inside ${agentLabel(state, claim.agentId)}'s claimed area ${claim.pattern}` +
          `${claim.reason ? ` (${claim.reason})` : ""}. This edit is allowed, but consider telling them with mp_message.`,
      );
    }
  }

  const lockPaths = paths.inside.filter((p) => !matchesAny(config.lockExempt, p));
  if (!lockPaths.length) return withContext({ decision: "allow" }, context);

  for (let attempt = 0; ; attempt++) {
    let result: LockAcquireResult;
    try {
      result = (await link.request({ op: "lock.acquire", agentId: agent.id, paths: lockPaths })) as LockAcquireResult;
    } catch (err) {
      if (err instanceof OfflineError) return withContext({ decision: "allow", additionalContext: OFFLINE_WARNING }, context);
      if (err instanceof OpFailedError && err.code === "not_found" && attempt === 0) {
        await env.reregister();
        continue;
      }
      return withContext(
        { decision: "allow", additionalContext: `Note: the room could not lock this file (${String((err as Error).message)}).` },
        context,
      );
    }

    if (result.granted) return withContext({ decision: "allow" }, context);
    if (result.frozenBy) {
      const remaining = deadline - now();
      const cleared = remaining > 0 && (await env.waitForFreezeClear(result.frozenBy.reviewId, remaining));
      if (cleared) continue;
      const review = link.mirror.state.reviews.get(result.frozenBy.reviewId);
      return {
        decision: "deny",
        reason:
          `Paused by the multiplayer room: a review is deciding whether ${review ? agentLabel(link.mirror.state, review.requesterAgentId) : "another agent"} ` +
          `may run \`${review?.command ?? "a shared-state command"}\`, which touches this file. ` +
          "Work on another part of your plan and retry this edit shortly.",
      };
    }
    return { decision: "deny", reason: formatLockDenial(result.held, link.mirror.state) };
  }
}
