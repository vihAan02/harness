import { z } from "zod";

export const Id = z.string().min(1).max(128);
export const Timestamp = z.number().int().nonnegative();

export const Vendor = z.enum(["claude", "codex"]);
export type Vendor = z.infer<typeof Vendor>;

/** Repo-relative POSIX path. Never absolute, never escapes the repo. */
export const RepoPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes(".."), {
    message: "must be a repo-relative POSIX path without '..'",
  });

/** A glob over repo-relative paths, e.g. `src/api/**`. */
export const PathPattern = z.string().min(1).max(1024);

export const ActorRef = z.object({
  type: z.enum(["agent", "member"]),
  id: Id,
});
export type ActorRef = z.infer<typeof ActorRef>;

export const Member = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  color: z.string().max(32).optional(),
  online: z.boolean(),
  lastSeenAt: Timestamp,
});
export type Member = z.infer<typeof Member>;

export const AgentStatus = z.enum([
  "starting",
  "idle",
  "thinking",
  "editing",
  "running",
  "blocked",
  "waiting_permission",
  "waiting_review",
  "offline",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const Agent = z.object({
  id: Id,
  memberId: Id,
  deviceId: Id,
  vendor: Vendor,
  model: z.string().max(80).optional(),
  name: z.string().min(1).max(80),
  status: AgentStatus,
  task: z.string().max(500).optional(),
  branch: z.string().max(255).optional(),
  baseBranch: z.string().max(255).optional(),
  startedAt: Timestamp,
  lastSeenAt: Timestamp,
});
export type Agent = z.infer<typeof Agent>;

export const PlanStepStatus = z.enum(["pending", "active", "done", "skipped"]);
export type PlanStepStatus = z.infer<typeof PlanStepStatus>;

export const PlanStep = z.object({
  id: Id,
  text: z.string().min(1).max(500),
  status: PlanStepStatus,
});
export type PlanStep = z.infer<typeof PlanStep>;

export const Plan = z.object({
  agentId: Id,
  title: z.string().min(1).max(200),
  summary: z.string().max(4000).optional(),
  steps: z.array(PlanStep).max(50),
  /** Paths or globs the agent expects to touch. */
  paths: z.array(PathPattern).max(100),
  updatedAt: Timestamp,
});
export type Plan = z.infer<typeof Plan>;

/** Soft, advisory ownership of an area of the repo. */
export const Claim = z.object({
  id: Id,
  agentId: Id,
  pattern: PathPattern,
  reason: z.string().max(500).optional(),
  createdAt: Timestamp,
});
export type Claim = z.infer<typeof Claim>;

/** Hard lock on a single file that has (or is about to have) unlanded edits. */
export const Lock = z.object({
  path: RepoPath,
  agentId: Id,
  acquiredAt: Timestamp,
  /** Last time the holder edited (re-acquired) this path. */
  renewedAt: Timestamp,
});
export type Lock = z.infer<typeof Lock>;

export const Hunk = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
});
export type Hunk = z.infer<typeof Hunk>;

export const DiffFile = z.object({
  path: RepoPath,
  oldPath: RepoPath.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(Hunk).max(1000),
  patch: z.string().optional(),
  truncated: z.boolean().optional(),
});
export type DiffFile = z.infer<typeof DiffFile>;

/** An agent's uncommitted + unlanded changes relative to its merge-base with the room's base branch. */
export const LiveDiff = z.object({
  agentId: Id,
  baseRef: z.string().max(255).optional(),
  files: z.array(DiffFile).max(2000),
  updatedAt: Timestamp,
});
export type LiveDiff = z.infer<typeof LiveDiff>;

export const ThreadKind = z.enum(["room", "direct", "group", "review"]);
export type ThreadKind = z.infer<typeof ThreadKind>;

export const Thread = z.object({
  id: Id,
  kind: ThreadKind,
  participants: z.array(ActorRef).max(50),
  topic: z.string().max(200).optional(),
  reviewId: Id.optional(),
  createdAt: Timestamp,
  lastMessageAt: Timestamp,
});
export type Thread = z.infer<typeof Thread>;

export const MessageKind = z.enum(["chat", "question", "answer", "handoff", "fyi", "system"]);
export type MessageKind = z.infer<typeof MessageKind>;

export const Message = z.object({
  id: Id,
  threadId: Id,
  from: ActorRef,
  to: z.array(ActorRef).max(50),
  kind: MessageKind,
  body: z.string().min(1).max(16_000),
  replyTo: Id.optional(),
  urgent: z.boolean().optional(),
  createdAt: Timestamp,
});
export type Message = z.infer<typeof Message>;

export const RiskTier = z.enum(["T0", "T1", "T2"]);
export type RiskTier = z.infer<typeof RiskTier>;

export const ReviewStatus = z.enum([
  "arbitrating",
  "mediating",
  "escalated",
  "approved",
  "denied",
  "queued",
  "cancelled",
]);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const OPEN_REVIEW_STATUSES: readonly ReviewStatus[] = ["arbitrating", "mediating", "escalated", "queued"];

export const Verdict = z.object({
  agentId: Id,
  decision: z.enum(["approve", "object", "approve_after"]),
  reason: z.string().max(2000),
  condition: z.string().max(500).optional(),
  at: Timestamp,
});
export type Verdict = z.infer<typeof Verdict>;

export const ReviewerVerdict = z.object({
  verdict: z.enum(["approve", "conflict", "needs_input"]),
  summary: z.string().max(4000),
  suggestion: z.string().max(2000).optional(),
});
export type ReviewerVerdict = z.infer<typeof ReviewerVerdict>;

export const HumanDecision = z.object({
  memberId: Id,
  decision: z.enum(["approve", "deny", "approve_after"]),
  note: z.string().max(2000).optional(),
  condition: z.string().max(500).optional(),
  at: Timestamp,
});
export type HumanDecision = z.infer<typeof HumanDecision>;

export const Impact = z.object({
  paths: z.array(PathPattern).max(500),
  resources: z.array(z.string().max(200)).max(50),
});
export type Impact = z.infer<typeof Impact>;

/** A critical-command review (see the command gate in the plan). */
export const Review = z.object({
  id: Id,
  requesterAgentId: Id,
  command: z.string().min(1).max(4000),
  tier: RiskTier,
  impact: Impact,
  dryRunPatch: z.string().max(200_000).optional(),
  affectedAgentIds: z.array(Id).max(50),
  status: ReviewStatus,
  alwaysHuman: z.boolean(),
  reviewer: ReviewerVerdict.optional(),
  verdicts: z.array(Verdict).max(100),
  humanDecision: HumanDecision.optional(),
  condition: z.string().max(500).optional(),
  threadId: Id.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  resolvedAt: Timestamp.optional(),
});
export type Review = z.infer<typeof Review>;

/** A scoped hold on paths while a review runs. */
export const Freeze = z.object({
  id: Id,
  reviewId: Id,
  scope: z.enum(["agents", "room"]),
  /** Frozen agents when scope is "agents". Ignored (everyone but the requester) for "room". */
  agentIds: z.array(Id).max(50),
  paths: z.array(PathPattern).max(500),
  createdAt: Timestamp,
});
export type Freeze = z.infer<typeof Freeze>;
