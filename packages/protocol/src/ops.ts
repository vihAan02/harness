import { z } from "zod";
import { AgentEvent } from "./agent-events.ts";
import {
  ActorRef,
  AgentStatus,
  DiffFile,
  Id,
  Impact,
  MessageKind,
  PathPattern,
  PlanStepStatus,
  RepoPath,
  ReviewStatus,
  ReviewerVerdict,
  RiskTier,
  Vendor,
} from "./entities.ts";

/** First message on every socket. Nothing else is accepted until it succeeds. */
export const Hello = z.object({
  op: z.literal("hello"),
  secret: z.string().min(16).max(256),
  member: z.object({
    id: Id,
    name: z.string().min(1).max(80),
    color: z.string().max(32).optional(),
  }),
  deviceId: Id,
  /** Last event seq this client has applied; lets the relay replay instead of sending a snapshot. */
  lastSeq: z.number().int().nonnegative().optional(),
});
export type Hello = z.infer<typeof Hello>;

const req = { reqId: z.string().min(1).max(64) };

export const AgentUpsert = z.object({
  op: z.literal("agent.upsert"),
  ...req,
  agent: z.object({
    id: Id,
    deviceId: Id,
    vendor: Vendor,
    model: z.string().max(80).optional(),
    name: z.string().min(1).max(80),
    status: AgentStatus.optional(),
    task: z.string().max(500).optional(),
    branch: z.string().max(255).optional(),
    baseBranch: z.string().max(255).optional(),
  }),
});

export const ClientOp = z.discriminatedUnion("op", [
  AgentUpsert,
  z.object({ op: z.literal("agent.remove"), ...req, agentId: Id }),
  z.object({ op: z.literal("heartbeat"), ...req, agentIds: z.array(Id).max(100) }),

  z.object({
    op: z.literal("plan.set"),
    ...req,
    agentId: Id,
    plan: z.object({
      title: z.string().min(1).max(200),
      summary: z.string().max(4000).optional(),
      steps: z
        .array(z.object({ id: Id, text: z.string().min(1).max(500), status: PlanStepStatus.default("pending") }))
        .max(50),
      paths: z.array(PathPattern).max(100).default([]),
    }),
  }),
  z.object({ op: z.literal("plan.step"), ...req, agentId: Id, stepId: Id, status: PlanStepStatus }),

  z.object({
    op: z.literal("claim.add"),
    ...req,
    agentId: Id,
    pattern: PathPattern,
    reason: z.string().max(500).optional(),
  }),
  /** Releases one claim by id or pattern, or all of the agent's claims when neither is given. */
  z.object({
    op: z.literal("claim.release"),
    ...req,
    agentId: Id,
    claimId: Id.optional(),
    pattern: PathPattern.optional(),
  }),

  /** All-or-nothing. Denied (not an error) if another agent holds any path or a freeze covers it. */
  z.object({ op: z.literal("lock.acquire"), ...req, agentId: Id, paths: z.array(RepoPath).min(1).max(100) }),
  /** Releases the given paths, or all of the agent's locks when `paths` is omitted. */
  z.object({ op: z.literal("lock.release"), ...req, agentId: Id, paths: z.array(RepoPath).max(500).optional() }),
  /** Human override: force-release someone else's lock. */
  z.object({ op: z.literal("lock.override"), ...req, path: RepoPath }),

  z.object({
    op: z.literal("diff.set"),
    ...req,
    agentId: Id,
    baseRef: z.string().max(255).optional(),
    files: z.array(DiffFile).max(2000),
  }),
  z.object({ op: z.literal("stream.push"), ...req, agentId: Id, events: z.array(AgentEvent).min(1).max(200) }),

  /**
   * Post a message. With `threadId`, posts there. Without it, `to` picks (or creates) the direct/group
   * thread with exactly those participants; empty `to` posts to the room thread.
   */
  z.object({
    op: z.literal("message.send"),
    ...req,
    from: ActorRef,
    threadId: Id.optional(),
    to: z.array(ActorRef).max(50).default([]),
    kind: MessageKind.default("chat"),
    body: z.string().min(1).max(16_000),
    replyTo: Id.optional(),
    urgent: z.boolean().optional(),
  }),

  z.object({
    op: z.literal("review.open"),
    ...req,
    review: z.object({
      requesterAgentId: Id,
      command: z.string().min(1).max(4000),
      tier: RiskTier,
      impact: Impact,
      dryRunPatch: z.string().max(200_000).optional(),
      affectedAgentIds: z.array(Id).max(50),
      alwaysHuman: z.boolean().default(false),
    }),
  }),
  z.object({
    op: z.literal("review.update"),
    ...req,
    reviewId: Id,
    patch: z.object({
      status: ReviewStatus.optional(),
      reviewer: ReviewerVerdict.optional(),
      condition: z.string().max(500).optional(),
      affectedAgentIds: z.array(Id).max(50).optional(),
    }),
  }),
  /** An affected agent's answer in a review thread. */
  z.object({
    op: z.literal("review.verdict"),
    ...req,
    reviewId: Id,
    agentId: Id,
    decision: z.enum(["approve", "object", "approve_after"]),
    reason: z.string().max(2000),
    condition: z.string().max(500).optional(),
  }),
  /** A human's decision on an escalated review. */
  z.object({
    op: z.literal("review.decide"),
    ...req,
    reviewId: Id,
    decision: z.enum(["approve", "deny", "approve_after"]),
    note: z.string().max(2000).optional(),
    condition: z.string().max(500).optional(),
  }),
  z.object({
    op: z.literal("freeze.set"),
    ...req,
    reviewId: Id,
    scope: z.enum(["agents", "room"]),
    agentIds: z.array(Id).max(50).default([]),
    paths: z.array(PathPattern).max(500),
  }),
  z.object({ op: z.literal("freeze.clear"), ...req, reviewId: Id }),
]);
export type ClientOp = z.infer<typeof ClientOp>;
export type ClientOpInput = z.input<typeof ClientOp>;
export type ClientOpName = ClientOp["op"];
export type OpOf<N extends ClientOpName> = Extract<ClientOp, { op: N }>;
