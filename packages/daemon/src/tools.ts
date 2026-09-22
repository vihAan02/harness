import { z } from "zod";
import { PlanStepStatus, type ActorRef, type Message } from "@mp/protocol";
import { computeCollisions, matchesAny, matchesPattern } from "@mp/room";
import { agentLabel, formatInbox, formatStatusTable } from "./format.ts";
import type { LocalAgent } from "./home.ts";
import type { RoomLink } from "./link.ts";

export class ToolError extends Error {}

export interface ToolContext {
  link: RoomLink;
  agent: LocalAgent;
  /** Pending messages for this agent; marks them delivered. */
  takeInbox: () => Promise<Message[]>;
  /** Resolves with the first reply to `messageId`, or null after `timeoutMs`. */
  waitForReply: (messageId: string, timeoutMs: number) => Promise<Message | null>;
}

export interface ToolResult {
  text: string;
  data?: unknown;
}

const args = {
  status: z.object({}).passthrough(),
  agent: z.object({ agentId: z.string().min(1) }),
  plan: z.object({
    title: z.string().min(1).max(200),
    summary: z.string().max(4000).optional(),
    steps: z
      .array(z.union([z.string().min(1).max(500), z.object({ id: z.string().optional(), text: z.string().min(1).max(500), status: PlanStepStatus.optional() })]))
      .max(50)
      .default([]),
    paths: z.array(z.string().min(1).max(1024)).max(100).default([]),
  }),
  update_plan: z.object({ stepId: z.string().min(1), status: PlanStepStatus }),
  claim: z.object({ pattern: z.string().min(1).max(1024), reason: z.string().max(500).optional() }),
  release: z.object({ pattern: z.string().min(1).max(1024).optional() }),
  message: z.object({
    to: z.union([z.string().min(1), z.array(z.string().min(1)).max(50)]),
    body: z.string().min(1).max(16_000),
    kind: z.enum(["chat", "fyi", "question", "handoff"]).default("chat"),
    urgent: z.boolean().optional(),
    threadId: z.string().optional(),
  }),
  answer: z.object({ messageId: z.string().min(1), body: z.string().min(1).max(16_000) }),
  inbox: z.object({}).passthrough(),
  who_touches: z.object({ path: z.string().min(1).max(1024) }),
  ask: z.object({
    agentId: z.string().min(1),
    question: z.string().min(1).max(16_000),
    waitSeconds: z.number().min(0).max(120).default(60),
  }),
  handoff: z.object({ agentId: z.string().min(1), request: z.string().min(1).max(16_000) }),
} as const;

export type ToolName = keyof typeof args;
export const TOOL_NAMES = Object.keys(args) as ToolName[];

function parse<N extends ToolName>(name: N, input: unknown): z.infer<(typeof args)[N]> {
  const res = args[name].safeParse(input ?? {});
  if (!res.success) throw new ToolError(res.error.issues.map((i) => `${i.path.join(".") || name}: ${i.message}`).join("; "));
  return res.data as z.infer<(typeof args)[N]>;
}

/** Resolves an agent id, a member id, an agent name (if unique), or "room". */
function resolveRecipient(ctx: ToolContext, who: string): ActorRef[] {
  const state = ctx.link.mirror.state;
  if (who === "room") return [];
  if (state.agents.has(who)) return [{ type: "agent", id: who }];
  if (state.members.has(who)) return [{ type: "member", id: who }];
  const byName = [...state.agents.values()].filter((a) => a.name === who);
  if (byName.length === 1) return [{ type: "agent", id: byName[0]!.id }];
  const known = [...state.agents.values()].map((a) => `${a.id} (${agentLabel(state, a.id)})`).join(", ");
  throw new ToolError(`unknown recipient "${who}". Known agents: ${known || "none"}. Use "room" to post to everyone.`);
}

function requireOtherAgent(ctx: ToolContext, agentId: string): void {
  const state = ctx.link.mirror.state;
  if (!state.agents.has(agentId)) {
    const known = [...state.agents.values()].filter((a) => a.id !== ctx.agent.id).map((a) => a.id).join(", ");
    throw new ToolError(`no agent "${agentId}" in the room. Other agents: ${known || "none"}.`);
  }
  if (agentId === ctx.agent.id) throw new ToolError("that's you");
}

function describeAgent(ctx: ToolContext, agentId: string): string {
  const state = ctx.link.mirror.state;
  const agent = state.agents.get(agentId)!;
  const plan = state.plans.get(agentId);
  const diff = state.diffs.get(agentId);
  const claims = [...state.claims.values()].filter((c) => c.agentId === agentId);
  const locks = [...state.locks.values()].filter((l) => l.agentId === agentId);
  const stream = (state.streams.get(agentId) ?? []).slice(-10);
  const lines = [
    `${agentLabel(state, agentId)}: ${agent.status}${agent.branch ? ` on ${agent.branch}` : ""}`,
    `Task: ${agent.task ?? plan?.title ?? "(none given)"}`,
  ];
  if (plan) {
    lines.push(`Plan "${plan.title}"${plan.summary ? `: ${plan.summary}` : ""}`);
    for (const s of plan.steps) lines.push(`  [${s.status}] ${s.id}: ${s.text}`);
    if (plan.paths.length) lines.push(`  expects to touch: ${plan.paths.join(", ")}`);
  } else lines.push("Plan: not published yet");
  lines.push(`Claimed: ${claims.map((c) => c.pattern).join(", ") || "nothing"}`);
  lines.push(`Locked: ${locks.map((l) => l.path).join(", ") || "nothing"}`);
  lines.push(
    `Changed files: ${diff?.files.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join(", ") || "none"}`,
  );
  if (stream.length) {
    lines.push("Recent activity:");
    for (const e of stream) lines.push(`  ${e.kind}: ${(e.text ?? e.input ?? e.tool ?? e.status ?? "").slice(0, 200)}`);
  }
  return lines.join("\n");
}

export async function runTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolResult> {
  if (!(TOOL_NAMES as string[]).includes(name)) throw new ToolError(`unknown tool ${name}. Tools: ${TOOL_NAMES.join(", ")}`);
  const { link, agent } = ctx;
  const me: ActorRef = { type: "agent", id: agent.id };
  const state = () => link.mirror.state;
  const offline = link.connected ? "" : "\n\n(The room is unreachable; this is the last known state.)";

  switch (name as ToolName) {
    case "status": {
      const rows = link.mirror.status();
      return { text: formatStatusTable(rows, state()) + offline, data: rows };
    }
    case "agent": {
      const a = parse("agent", input);
      if (!state().agents.has(a.agentId)) throw new ToolError(`no agent "${a.agentId}" in the room`);
      return { text: describeAgent(ctx, a.agentId) + offline };
    }
    case "plan": {
      const a = parse("plan", input);
      const steps = a.steps.map((s, i) =>
        typeof s === "string" ? { id: `s${i + 1}`, text: s, status: "pending" as const } : { id: s.id ?? `s${i + 1}`, text: s.text, status: s.status ?? "pending" },
      );
      const plan = await link.request({
        op: "plan.set",
        agentId: agent.id,
        plan: { title: a.title, ...(a.summary ? { summary: a.summary } : {}), steps, paths: a.paths },
      });
      return {
        text: `Plan published: "${a.title}" with ${steps.length} steps (${steps.map((s) => s.id).join(", ")}). Mark progress with mp_update_plan.`,
        data: plan,
      };
    }
    case "update_plan": {
      const a = parse("update_plan", input);
      const plan = await link.request({ op: "plan.step", agentId: agent.id, stepId: a.stepId, status: a.status });
      return { text: `Step ${a.stepId} is now ${a.status}.`, data: plan };
    }
    case "claim": {
      const a = parse("claim", input);
      const res = (await link.request({
        op: "claim.add",
        agentId: agent.id,
        pattern: a.pattern,
        ...(a.reason ? { reason: a.reason } : {}),
      })) as { overlaps: { agentId: string; pattern: string }[] };
      const warn = res.overlaps.map((o) => `- overlaps ${agentLabel(state(), o.agentId)}'s claim ${o.pattern}`);
      return {
        text: `Claimed ${a.pattern}.${warn.length ? `\nCoordinate before working there:\n${warn.join("\n")}` : ""}`,
        data: res,
      };
    }
    case "release": {
      const a = parse("release", input);
      const res = await link.request({ op: "claim.release", agentId: agent.id, ...(a.pattern ? { pattern: a.pattern } : {}) });
      return { text: a.pattern ? `Released ${a.pattern}.` : "Released all your claims.", data: res };
    }
    case "message": {
      const a = parse("message", input);
      const to = (Array.isArray(a.to) ? a.to : [a.to]).flatMap((w) => resolveRecipient(ctx, w));
      const res = await link.request({
        op: "message.send",
        from: me,
        to,
        kind: a.kind,
        body: a.body,
        ...(a.threadId ? { threadId: a.threadId } : {}),
        ...(a.urgent !== undefined ? { urgent: a.urgent } : {}),
      });
      return { text: `Sent to ${to.length ? to.map((r) => (r.type === "agent" ? agentLabel(state(), r.id) : r.id)).join(", ") : "the room"}.`, data: res };
    }
    case "answer": {
      const a = parse("answer", input);
      const original = state().messages.get(a.messageId);
      if (!original) throw new ToolError(`no message ${a.messageId} (it may have scrolled out of the thread)`);
      const res = await link.request({
        op: "message.send",
        from: me,
        to: [original.from],
        kind: "answer",
        body: a.body,
        replyTo: a.messageId,
      });
      return { text: "Answer sent.", data: res };
    }
    case "inbox": {
      parse("inbox", input);
      const messages = await ctx.takeInbox();
      return { text: messages.length ? formatInbox(messages, state()) : "No new messages.", data: messages };
    }
    case "who_touches": {
      const a = parse("who_touches", input);
      const s = state();
      const p = a.path.replace(/^\.\//, "");
      const lines: string[] = [];
      for (const l of s.locks.values()) if (matchesPattern(p, l.path) || l.path === p) lines.push(`- locked by ${agentLabel(s, l.agentId)}: ${l.path}`);
      for (const c of s.claims.values()) if (matchesPattern(c.pattern, p) || matchesPattern(p, c.pattern)) lines.push(`- claimed by ${agentLabel(s, c.agentId)}: ${c.pattern}`);
      for (const d of s.diffs.values()) {
        const files = d.files.filter((f) => f.path === p || matchesPattern(p, f.path));
        if (files.length) lines.push(`- changed by ${agentLabel(s, d.agentId)}: ${files.map((f) => f.path).join(", ")}`);
      }
      for (const plan of s.plans.values()) if (matchesAny(plan.paths, p)) lines.push(`- in the plan of ${agentLabel(s, plan.agentId)}: "${plan.title}"`);
      for (const c of computeCollisions(s)) if (c.path === p || matchesPattern(p, c.path)) lines.push(`- collision on ${c.path} between ${c.agentIds.map((id) => agentLabel(s, id)).join(" and ")}`);
      return { text: lines.length ? `${p}:\n${lines.join("\n")}` : `Nobody else is touching ${p}.` };
    }
    case "ask": {
      const a = parse("ask", input);
      requireOtherAgent(ctx, a.agentId);
      const sent = (await link.request({
        op: "message.send",
        from: me,
        to: [{ type: "agent", id: a.agentId }],
        kind: "question",
        body: a.question,
      })) as { messageId: string; threadId: string };
      const reply = await ctx.waitForReply(sent.messageId, a.waitSeconds * 1000);
      const who = agentLabel(state(), a.agentId);
      if (!reply) {
        return {
          text: `${who} hasn't answered yet. Their answer will arrive in your inbox (mp_inbox). In the meantime you can check their record with mp_agent.`,
          data: { answered: false, messageId: sent.messageId },
        };
      }
      return { text: `${who} answered: ${reply.body}`, data: { answered: true, answer: reply.body, messageId: reply.id } };
    }
    case "handoff": {
      const a = parse("handoff", input);
      requireOtherAgent(ctx, a.agentId);
      const res = await link.request({
        op: "message.send",
        from: me,
        to: [{ type: "agent", id: a.agentId }],
        kind: "handoff",
        urgent: true,
        body: a.request,
      });
      return { text: `Handoff sent to ${agentLabel(state(), a.agentId)}. They'll reply with mp_answer.`, data: res };
    }
  }
}

