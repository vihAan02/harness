import {
  OPEN_REVIEW_STATUSES,
  type ActorRef,
  type Agent,
  type AgentEvent,
  type ClientOp,
  type DiffFile,
  type ErrorCode,
  type Freeze,
  type Lock,
  type LockAcquireResult,
  type LockHolder,
  type LockReleaseReason,
  type Member,
  type Message,
  type OpError,
  type OpOf,
  type Review,
  type ReviewStatus,
  type RoomEvent,
  type RoomEventBody,
  type RoomSnapshot,
  type StatusRow,
  type Thread,
} from "@mp/protocol";
import { matchesAny, patternsOverlap } from "./paths.ts";
import {
  emptyState,
  snapshotOf,
  stateFromSnapshot,
  type Change,
  type Collection,
  type CollectionTypes,
  type RoomState,
} from "./state.ts";
import { computeStatus } from "./status.ts";

export interface EngineOptions {
  maxStreamPerAgent: number;
  maxMessagesPerThread: number;
  /** Agents with no heartbeat for this long are marked offline. */
  agentOfflineMs: number;
  /** Locks held by an agent that has been offline this long are released. */
  lockStaleMs: number;
  /** A lock whose file is no longer in the holder's live diff is released after this grace period. */
  lockCleanGraceMs: number;
  maxPatchBytesPerFile: number;
  maxPatchBytesTotal: number;
  newId: () => string;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  maxStreamPerAgent: 500,
  maxMessagesPerThread: 500,
  agentOfflineMs: 60_000,
  lockStaleMs: 30 * 60_000,
  lockCleanGraceMs: 2 * 60_000,
  maxPatchBytesPerFile: 64_000,
  maxPatchBytesTotal: 512_000,
  newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
};

export const ROOM_THREAD_ID = "room";

const RESOLVED: readonly ReviewStatus[] = ["approved", "denied", "cancelled"];

export interface OpContext {
  memberId: string;
  now: number;
}

export interface ApplyResult {
  ok: boolean;
  result?: unknown;
  error?: OpError;
  /** Seq'd events to broadcast, in order. */
  events: RoomEvent[];
  /** Ephemeral stream entries to broadcast. */
  stream?: { agentId: string; events: AgentEvent[] };
  /** Persistence deltas. */
  changes: Change[];
}

class OpFailure extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: ErrorCode, message: string): never {
  throw new OpFailure(code, message);
}

function refKey(r: ActorRef): string {
  return `${r.type}:${r.id}`;
}

function sameRefSet(a: readonly ActorRef[], b: readonly ActorRef[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map(refKey));
  return b.every((r) => keys.has(refKey(r)));
}

function uniqRefs(refs: readonly ActorRef[]): ActorRef[] {
  const seen = new Map<string, ActorRef>();
  for (const r of refs) seen.set(refKey(r), r);
  return [...seen.values()];
}

function byteLength(s: string): number {
  // UTF-8 length without TextEncoder, so this stays portable across runtimes.
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Collects the events and persistence deltas of one operation. */
class Tx {
  readonly events: RoomEvent[] = [];
  readonly changes: Change[] = [];
  private readonly state: RoomState;
  readonly by: string | null;
  readonly now: number;

  constructor(state: RoomState, by: string | null, now: number) {
    this.state = state;
    this.by = by;
    this.now = now;
  }

  emit(body: RoomEventBody): void {
    this.state.seq += 1;
    this.events.push({ ...body, seq: this.state.seq, at: this.now, by: this.by } as RoomEvent);
  }

  put<C extends Collection>(collection: C, id: string, value: CollectionTypes[C]): void {
    (this.state[collection] as Map<string, CollectionTypes[C]>).set(id, value);
    this.changes.push({ kind: "put", collection, id, value });
  }

  del(collection: Collection, id: string): void {
    if (this.state[collection].delete(id)) this.changes.push({ kind: "del", collection, id });
  }
}

/**
 * The room state machine. Deterministic given (state, op, now, newId): every mutation goes through
 * `apply`, `connect`, `disconnect` or `tick`, and validation happens before any mutation.
 */
export class RoomEngine {
  readonly state: RoomState;
  readonly opts: EngineOptions;

  constructor(roomIdOrState: string | RoomState, opts: Partial<EngineOptions> = {}) {
    this.state = typeof roomIdOrState === "string" ? emptyState(roomIdOrState) : roomIdOrState;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  static fromSnapshot(snap: RoomSnapshot, opts: Partial<EngineOptions> = {}): RoomEngine {
    return new RoomEngine(stateFromSnapshot(snap), opts);
  }

  snapshot(): RoomSnapshot {
    return snapshotOf(this.state);
  }

  status(): StatusRow[] {
    return computeStatus(this.state);
  }

  // ---------------------------------------------------------------- presence

  connect(member: { id: string; name: string; color?: string | undefined }, now: number): ApplyResult {
    const tx = new Tx(this.state, member.id, now);
    const next: Member = {
      id: member.id,
      name: member.name,
      ...(member.color !== undefined ? { color: member.color } : {}),
      online: true,
      lastSeenAt: now,
    };
    tx.put("members", member.id, next);
    tx.emit({ type: "member.updated", member: next });
    return { ok: true, events: tx.events, changes: tx.changes };
  }

  /** Call when a member's last socket closes. */
  disconnect(memberId: string, now: number): ApplyResult {
    const tx = new Tx(this.state, null, now);
    const m = this.state.members.get(memberId);
    if (m && m.online) {
      const next = { ...m, online: false, lastSeenAt: now };
      tx.put("members", memberId, next);
      tx.emit({ type: "member.updated", member: next });
    }
    return { ok: true, events: tx.events, changes: tx.changes };
  }

  // ---------------------------------------------------------------- ops

  apply(ctx: OpContext, op: ClientOp): ApplyResult {
    const tx = new Tx(this.state, ctx.memberId, ctx.now);
    try {
      const out = this.dispatch(ctx, op, tx);
      return {
        ok: true,
        result: out.result,
        events: tx.events,
        changes: tx.changes,
        ...(out.stream ? { stream: out.stream } : {}),
      };
    } catch (err) {
      if (err instanceof OpFailure) {
        if (tx.changes.length > 0) {
          // Handlers validate before mutating; reaching here is a bug worth surfacing loudly.
          throw new Error(`op ${op.op} failed after mutating state: ${err.message}`);
        }
        return { ok: false, error: { code: err.code, message: err.message }, events: [], changes: [] };
      }
      throw err;
    }
  }

  private dispatch(
    ctx: OpContext,
    op: ClientOp,
    tx: Tx,
  ): { result?: unknown; stream?: { agentId: string; events: AgentEvent[] } } {
    switch (op.op) {
      case "agent.upsert":
        return { result: this.agentUpsert(ctx, op, tx) };
      case "agent.remove":
        this.agentRemove(ctx, op.agentId, tx);
        return {};
      case "heartbeat":
        this.heartbeat(ctx, op.agentIds, tx);
        return {};
      case "plan.set":
        return { result: this.planSet(ctx, op, tx) };
      case "plan.step":
        return { result: this.planStep(ctx, op, tx) };
      case "claim.add":
        return { result: this.claimAdd(ctx, op, tx) };
      case "claim.release":
        return { result: this.claimRelease(ctx, op, tx) };
      case "lock.acquire":
        return { result: this.lockAcquire(ctx, op.agentId, op.paths, tx) };
      case "lock.release":
        return { result: this.lockRelease(ctx, op.agentId, op.paths, tx) };
      case "lock.override":
        return { result: this.lockOverride(op.path, tx) };
      case "diff.set":
        return { result: this.diffSet(ctx, op, tx) };
      case "stream.push":
        return { stream: this.streamPush(ctx, op.agentId, op.events, tx) };
      case "message.send":
        return { result: this.messageSend(ctx, op, tx) };
      case "review.open":
        return { result: this.reviewOpen(ctx, op, tx) };
      case "review.update":
        return { result: this.reviewUpdate(ctx, op, tx) };
      case "review.verdict":
        return { result: this.reviewVerdict(ctx, op, tx) };
      case "review.decide":
        return { result: this.reviewDecide(ctx, op, tx) };
      case "freeze.set":
        return { result: this.freezeSet(ctx, op, tx) };
      case "freeze.clear":
        return { result: this.freezeClear(ctx, op.reviewId, tx) };
    }
  }

  private ownAgent(ctx: OpContext, agentId: string): Agent {
    const agent = this.state.agents.get(agentId);
    if (!agent) fail("not_found", `agent ${agentId} not found`);
    if (agent.memberId !== ctx.memberId) fail("forbidden", `agent ${agentId} belongs to another member`);
    return agent;
  }

  // ---- agents

  private agentUpsert(ctx: OpContext, op: OpOf<"agent.upsert">, tx: Tx): Agent {
    const input = op.agent;
    const existing = this.state.agents.get(input.id);
    if (existing && existing.memberId !== ctx.memberId) fail("forbidden", `agent ${input.id} belongs to another member`);
    const agent: Agent = {
      ...existing,
      ...input,
      memberId: ctx.memberId,
      status: input.status ?? existing?.status ?? "starting",
      startedAt: existing?.startedAt ?? ctx.now,
      lastSeenAt: ctx.now,
    };
    tx.put("agents", agent.id, agent);
    tx.emit({ type: "agent.updated", agent });
    return agent;
  }

  private agentRemove(ctx: OpContext, agentId: string, tx: Tx): void {
    this.ownAgent(ctx, agentId);
    this.removeAgentCascade(agentId, tx);
  }

  private removeAgentCascade(agentId: string, tx: Tx): void {
    const lockPaths = [...this.state.locks.values()].filter((l) => l.agentId === agentId).map((l) => l.path);
    if (lockPaths.length) {
      for (const p of lockPaths) tx.del("locks", p);
      tx.emit({ type: "lock.released", agentId, paths: lockPaths, reason: "agent_removed" });
    }
    const claimIds = [...this.state.claims.values()].filter((c) => c.agentId === agentId).map((c) => c.id);
    if (claimIds.length) {
      for (const id of claimIds) tx.del("claims", id);
      tx.emit({ type: "claim.released", agentId, claimIds });
    }
    if (this.state.plans.has(agentId)) {
      tx.del("plans", agentId);
      tx.emit({ type: "plan.removed", agentId });
    }
    if (this.state.diffs.has(agentId)) {
      tx.del("diffs", agentId);
      tx.emit({ type: "diff.removed", agentId });
    }
    if (this.state.streams.delete(agentId)) tx.changes.push({ kind: "stream.clear", agentId });
    tx.del("agents", agentId);
    tx.emit({ type: "agent.removed", agentId });
  }

  private heartbeat(ctx: OpContext, agentIds: readonly string[], tx: Tx): void {
    const agents = agentIds.map((id) => this.ownAgent(ctx, id));
    const member = this.state.members.get(ctx.memberId);
    if (member) tx.put("members", member.id, { ...member, online: true, lastSeenAt: ctx.now });
    for (const agent of agents) {
      const revived = agent.status === "offline";
      const next: Agent = { ...agent, lastSeenAt: ctx.now, ...(revived ? { status: "idle" as const } : {}) };
      tx.put("agents", agent.id, next);
      // Heartbeats are frequent; only broadcast when something visible changed.
      if (revived) tx.emit({ type: "agent.updated", agent: next });
    }
  }

  // ---- plans

  private planSet(ctx: OpContext, op: OpOf<"plan.set">, tx: Tx) {
    this.ownAgent(ctx, op.agentId);
    const ids = new Set(op.plan.steps.map((s) => s.id));
    if (ids.size !== op.plan.steps.length) fail("bad_request", "plan step ids must be unique");
    const plan = {
      agentId: op.agentId,
      title: op.plan.title,
      ...(op.plan.summary !== undefined ? { summary: op.plan.summary } : {}),
      steps: op.plan.steps,
      paths: op.plan.paths,
      updatedAt: ctx.now,
    };
    tx.put("plans", op.agentId, plan);
    tx.emit({ type: "plan.updated", plan });
    return plan;
  }

  private planStep(ctx: OpContext, op: OpOf<"plan.step">, tx: Tx) {
    this.ownAgent(ctx, op.agentId);
    const plan = this.state.plans.get(op.agentId);
    if (!plan) fail("not_found", "agent has no plan");
    if (!plan.steps.some((s) => s.id === op.stepId)) fail("not_found", `step ${op.stepId} not in plan`);
    const next = {
      ...plan,
      steps: plan.steps.map((s) => (s.id === op.stepId ? { ...s, status: op.status } : s)),
      updatedAt: ctx.now,
    };
    tx.put("plans", op.agentId, next);
    tx.emit({ type: "plan.updated", plan: next });
    return next;
  }

  // ---- claims

  private claimAdd(ctx: OpContext, op: OpOf<"claim.add">, tx: Tx) {
    this.ownAgent(ctx, op.agentId);
    const claims = [...this.state.claims.values()];
    const overlaps = claims
      .filter((c) => c.agentId !== op.agentId && patternsOverlap(c.pattern, op.pattern))
      .map((c) => ({ claimId: c.id, agentId: c.agentId, pattern: c.pattern }));
    const existing = claims.find((c) => c.agentId === op.agentId && c.pattern === op.pattern);
    if (existing) return { claim: existing, overlaps };
    const claim = {
      id: this.opts.newId(),
      agentId: op.agentId,
      pattern: op.pattern,
      ...(op.reason !== undefined ? { reason: op.reason } : {}),
      createdAt: ctx.now,
    };
    tx.put("claims", claim.id, claim);
    tx.emit({ type: "claim.added", claim });
    return { claim, overlaps };
  }

  private claimRelease(ctx: OpContext, op: OpOf<"claim.release">, tx: Tx) {
    this.ownAgent(ctx, op.agentId);
    const mine = [...this.state.claims.values()].filter((c) => c.agentId === op.agentId);
    const targets = mine.filter((c) =>
      op.claimId !== undefined ? c.id === op.claimId : op.pattern !== undefined ? c.pattern === op.pattern : true,
    );
    if ((op.claimId !== undefined || op.pattern !== undefined) && targets.length === 0) {
      fail("not_found", "no matching claim");
    }
    for (const c of targets) tx.del("claims", c.id);
    if (targets.length) tx.emit({ type: "claim.released", agentId: op.agentId, claimIds: targets.map((c) => c.id) });
    return { released: targets.map((c) => c.id) };
  }

  // ---- locks

  /** Freezes that hold `agentId`'s work on `path`, if any. */
  freezeFor(agentId: string, path: string): Freeze | undefined {
    for (const f of this.state.freezes.values()) {
      const review = this.state.reviews.get(f.reviewId);
      if (!review || RESOLVED.includes(review.status)) continue;
      if (review.requesterAgentId === agentId) continue;
      const frozen = f.scope === "room" || f.agentIds.includes(agentId);
      if (frozen && matchesAny(f.paths, path)) return f;
    }
    return undefined;
  }

  lockHolder(lock: Lock): LockHolder {
    const agent = this.state.agents.get(lock.agentId);
    const member = agent ? this.state.members.get(agent.memberId) : undefined;
    const plan = this.state.plans.get(lock.agentId);
    const active = plan?.steps.find((s) => s.status === "active");
    return {
      path: lock.path,
      agentId: lock.agentId,
      agentName: agent?.name ?? lock.agentId,
      memberName: member?.name ?? agent?.memberId ?? "unknown",
      ...(plan ? { planTitle: plan.title } : {}),
      ...(active ? { activeStep: active.text } : {}),
    };
  }

  private lockAcquire(ctx: OpContext, agentId: string, rawPaths: readonly string[], tx: Tx): LockAcquireResult {
    this.ownAgent(ctx, agentId);
    const paths = [...new Set(rawPaths)];
    for (const p of paths) {
      const freeze = this.freezeFor(agentId, p);
      if (freeze) return { granted: false, held: [], frozenBy: { reviewId: freeze.reviewId, freezeId: freeze.id } };
    }
    const held = paths
      .map((p) => this.state.locks.get(p))
      .filter((l): l is Lock => l !== undefined && l.agentId !== agentId)
      .map((l) => this.lockHolder(l));
    if (held.length) return { granted: false, held };

    const acquired: Lock[] = [];
    for (const p of paths) {
      const existing = this.state.locks.get(p);
      if (existing) {
        tx.put("locks", p, { ...existing, renewedAt: ctx.now });
      } else {
        const lock: Lock = { path: p, agentId, acquiredAt: ctx.now, renewedAt: ctx.now };
        tx.put("locks", p, lock);
        acquired.push(lock);
      }
    }
    if (acquired.length) tx.emit({ type: "lock.acquired", agentId, locks: acquired });
    return { granted: true, paths };
  }

  private releaseLocks(agentId: string, paths: string[], reason: LockReleaseReason, tx: Tx): void {
    if (!paths.length) return;
    for (const p of paths) tx.del("locks", p);
    tx.emit({ type: "lock.released", agentId, paths, reason });
  }

  private lockRelease(ctx: OpContext, agentId: string, paths: readonly string[] | undefined, tx: Tx) {
    this.ownAgent(ctx, agentId);
    const mine = [...this.state.locks.values()].filter((l) => l.agentId === agentId).map((l) => l.path);
    const targets = paths ? mine.filter((p) => paths.includes(p)) : mine;
    this.releaseLocks(agentId, targets, "released", tx);
    return { released: targets };
  }

  private lockOverride(path: string, tx: Tx) {
    const lock = this.state.locks.get(path);
    if (!lock) fail("not_found", `no lock on ${path}`);
    this.releaseLocks(lock.agentId, [path], "override", tx);
    return { released: [path], previousHolder: lock.agentId };
  }

  // ---- diffs & streams

  private diffSet(ctx: OpContext, op: OpOf<"diff.set">, tx: Tx) {
    this.ownAgent(ctx, op.agentId);
    let budget = this.opts.maxPatchBytesTotal;
    let truncated = false;
    const files: DiffFile[] = op.files.map((f) => {
      if (f.patch === undefined) return f;
      const size = byteLength(f.patch);
      if (size > this.opts.maxPatchBytesPerFile || size > budget) {
        truncated = true;
        const { patch: _dropped, ...rest } = f;
        return { ...rest, truncated: true };
      }
      budget -= size;
      return f;
    });
    const diff = {
      agentId: op.agentId,
      ...(op.baseRef !== undefined ? { baseRef: op.baseRef } : {}),
      files,
      updatedAt: ctx.now,
    };
    tx.put("diffs", op.agentId, diff);
    tx.emit({ type: "diff.updated", diff });
    return { files: files.length, truncated };
  }

  private streamPush(ctx: OpContext, agentId: string, events: AgentEvent[], tx: Tx) {
    this.ownAgent(ctx, agentId);
    const buf = this.state.streams.get(agentId) ?? [];
    buf.push(...events);
    if (buf.length > this.opts.maxStreamPerAgent) buf.splice(0, buf.length - this.opts.maxStreamPerAgent);
    this.state.streams.set(agentId, buf);
    tx.changes.push({ kind: "stream.append", agentId, events, keep: this.opts.maxStreamPerAgent });
    return { agentId, events };
  }

  // ---- threads & messages

  private checkRef(ctx: OpContext, ref: ActorRef, asSender: boolean): void {
    if (ref.type === "agent") {
      if (asSender) this.ownAgent(ctx, ref.id);
      else if (!this.state.agents.has(ref.id)) fail("not_found", `agent ${ref.id} not found`);
    } else {
      if (asSender && ref.id !== ctx.memberId) fail("forbidden", "cannot send as another member");
      if (!asSender && !this.state.members.has(ref.id)) fail("not_found", `member ${ref.id} not found`);
    }
  }

  private messageSend(ctx: OpContext, op: OpOf<"message.send">, tx: Tx) {
    this.checkRef(ctx, op.from, true);
    for (const r of op.to) this.checkRef(ctx, r, false);

    let threadId = op.threadId;
    if (op.replyTo !== undefined) {
      const parent = this.state.messages.get(op.replyTo);
      if (!parent) fail("not_found", `message ${op.replyTo} not found`);
      if (threadId !== undefined && threadId !== parent.threadId) fail("bad_request", "replyTo is in another thread");
      threadId = parent.threadId;
    }

    let thread: Thread | undefined;
    let isNew = false;
    if (threadId !== undefined) {
      thread = this.state.threads.get(threadId);
      if (!thread && threadId !== ROOM_THREAD_ID) fail("not_found", `thread ${threadId} not found`);
    }
    if (!thread && (threadId === ROOM_THREAD_ID || op.to.length === 0)) {
      thread = this.state.threads.get(ROOM_THREAD_ID);
      if (!thread) {
        thread = { id: ROOM_THREAD_ID, kind: "room", participants: [], topic: "Room", createdAt: ctx.now, lastMessageAt: ctx.now };
        isNew = true;
      }
    }
    if (!thread) {
      const participants = uniqRefs([op.from, ...op.to]);
      thread = [...this.state.threads.values()].find(
        (t) => (t.kind === "direct" || t.kind === "group") && sameRefSet(t.participants, participants),
      );
      if (!thread) {
        thread = {
          id: this.opts.newId(),
          kind: participants.length === 2 ? "direct" : "group",
          participants,
          createdAt: ctx.now,
          lastMessageAt: ctx.now,
        };
        isNew = true;
      }
    }

    const participants =
      thread.kind === "room" ? thread.participants : uniqRefs([...thread.participants, op.from]);
    const nextThread: Thread = { ...thread, participants, lastMessageAt: ctx.now };
    tx.put("threads", nextThread.id, nextThread);
    if (isNew) tx.emit({ type: "thread.opened", thread: nextThread });

    const message: Message = {
      id: this.opts.newId(),
      threadId: nextThread.id,
      from: op.from,
      to: op.to,
      kind: op.kind,
      body: op.body,
      ...(op.replyTo !== undefined ? { replyTo: op.replyTo } : {}),
      ...(op.urgent !== undefined ? { urgent: op.urgent } : {}),
      createdAt: ctx.now,
    };
    this.postMessage(message, tx);
    return { threadId: nextThread.id, messageId: message.id };
  }

  private postMessage(message: Message, tx: Tx): void {
    tx.put("messages", message.id, message);
    tx.emit({ type: "message.posted", message });
    const inThread = [...this.state.messages.values()]
      .filter((m) => m.threadId === message.threadId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = inThread.length - this.opts.maxMessagesPerThread;
    for (let i = 0; i < excess; i++) tx.del("messages", inThread[i]!.id);
  }

  private systemMessage(threadId: string, from: ActorRef, body: string, tx: Tx, kind: Message["kind"] = "system") {
    this.postMessage({ id: this.opts.newId(), threadId, from, to: [], kind, body, createdAt: tx.now }, tx);
  }

  // ---- reviews & freezes

  private openReview(reviewId: string): Review {
    const review = this.state.reviews.get(reviewId);
    if (!review) fail("not_found", `review ${reviewId} not found`);
    if (RESOLVED.includes(review.status)) fail("conflict", `review ${reviewId} is already ${review.status}`);
    return review;
  }

  private requireRequesterOwner(ctx: OpContext, review: Review): void {
    const requester = this.state.agents.get(review.requesterAgentId);
    if (!requester || requester.memberId !== ctx.memberId) fail("forbidden", "only the requester's owner can do this");
  }

  private reviewOpen(ctx: OpContext, op: OpOf<"review.open">, tx: Tx) {
    const input = op.review;
    this.ownAgent(ctx, input.requesterAgentId);
    const affected = [...new Set(input.affectedAgentIds)].filter((id) => id !== input.requesterAgentId);
    for (const id of affected) if (!this.state.agents.has(id)) fail("not_found", `agent ${id} not found`);

    const reviewId = this.opts.newId();
    const threadId = this.opts.newId();
    const review: Review = {
      id: reviewId,
      requesterAgentId: input.requesterAgentId,
      command: input.command,
      tier: input.tier,
      impact: input.impact,
      ...(input.dryRunPatch !== undefined ? { dryRunPatch: input.dryRunPatch } : {}),
      affectedAgentIds: affected,
      status: "arbitrating",
      alwaysHuman: input.alwaysHuman,
      verdicts: [],
      threadId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    const thread: Thread = {
      id: threadId,
      kind: "review",
      reviewId,
      participants: [input.requesterAgentId, ...affected].map((id) => ({ type: "agent" as const, id })),
      topic: `Review: ${input.command.slice(0, 160)}`,
      createdAt: ctx.now,
      lastMessageAt: ctx.now,
    };
    tx.put("reviews", reviewId, review);
    tx.put("threads", threadId, thread);
    tx.emit({ type: "review.updated", review });
    tx.emit({ type: "thread.opened", thread });
    const touches = input.impact.paths.length ? input.impact.paths.slice(0, 20).join(", ") : "shared state";
    this.systemMessage(
      threadId,
      { type: "agent", id: input.requesterAgentId },
      `Requesting to run \`${input.command}\` (${input.tier}). It touches: ${touches}.`,
      tx,
    );
    return { reviewId, threadId };
  }

  private resolveSideEffects(review: Review, tx: Tx): void {
    if (!OPEN_REVIEW_STATUSES.includes(review.status) || review.status === "queued") {
      for (const f of [...this.state.freezes.values()].filter((f) => f.reviewId === review.id)) {
        tx.del("freezes", f.id);
        tx.emit({ type: "freeze.cleared", freezeId: f.id, reviewId: review.id });
      }
    }
  }

  private reviewUpdate(ctx: OpContext, op: OpOf<"review.update">, tx: Tx) {
    const review = this.openReview(op.reviewId);
    this.requireRequesterOwner(ctx, review);
    const affected = op.patch.affectedAgentIds;
    if (affected) for (const id of affected) if (!this.state.agents.has(id)) fail("not_found", `agent ${id} not found`);
    const status = op.patch.status ?? review.status;
    const next: Review = {
      ...review,
      ...(op.patch.reviewer ? { reviewer: op.patch.reviewer } : {}),
      ...(op.patch.condition !== undefined ? { condition: op.patch.condition } : {}),
      ...(affected ? { affectedAgentIds: affected.filter((id) => id !== review.requesterAgentId) } : {}),
      status,
      updatedAt: ctx.now,
      ...(RESOLVED.includes(status) ? { resolvedAt: ctx.now } : {}),
    };
    tx.put("reviews", next.id, next);
    tx.emit({ type: "review.updated", review: next });
    this.resolveSideEffects(next, tx);
    return next;
  }

  private reviewVerdict(ctx: OpContext, op: OpOf<"review.verdict">, tx: Tx) {
    const review = this.openReview(op.reviewId);
    this.ownAgent(ctx, op.agentId);
    if (!review.affectedAgentIds.includes(op.agentId)) fail("forbidden", "agent is not part of this review");
    const verdict = {
      agentId: op.agentId,
      decision: op.decision,
      reason: op.reason,
      ...(op.condition !== undefined ? { condition: op.condition } : {}),
      at: ctx.now,
    };
    const next: Review = {
      ...review,
      verdicts: [...review.verdicts.filter((v) => v.agentId !== op.agentId), verdict],
      updatedAt: ctx.now,
    };
    tx.put("reviews", next.id, next);
    tx.emit({ type: "review.updated", review: next });
    if (review.threadId) {
      const cond = op.condition ? ` (after: ${op.condition})` : "";
      this.systemMessage(review.threadId, { type: "agent", id: op.agentId }, `${op.decision}${cond}: ${op.reason}`, tx, "answer");
    }
    return next;
  }

  private reviewDecide(ctx: OpContext, op: OpOf<"review.decide">, tx: Tx) {
    const review = this.openReview(op.reviewId);
    const involved = [review.requesterAgentId, ...review.affectedAgentIds];
    const owns = involved.some((id) => this.state.agents.get(id)?.memberId === ctx.memberId);
    if (!owns) fail("forbidden", "only owners of the agents involved can decide");
    const status: ReviewStatus = op.decision === "approve" ? "approved" : op.decision === "deny" ? "denied" : "queued";
    const next: Review = {
      ...review,
      humanDecision: {
        memberId: ctx.memberId,
        decision: op.decision,
        ...(op.note !== undefined ? { note: op.note } : {}),
        ...(op.condition !== undefined ? { condition: op.condition } : {}),
        at: ctx.now,
      },
      ...(op.condition !== undefined ? { condition: op.condition } : {}),
      status,
      updatedAt: ctx.now,
      ...(RESOLVED.includes(status) ? { resolvedAt: ctx.now } : {}),
    };
    tx.put("reviews", next.id, next);
    tx.emit({ type: "review.updated", review: next });
    if (review.threadId) {
      const note = op.note ? `: ${op.note}` : "";
      this.systemMessage(review.threadId, { type: "member", id: ctx.memberId }, `Human decision: ${op.decision}${note}`, tx);
    }
    this.resolveSideEffects(next, tx);
    return next;
  }

  private freezeSet(ctx: OpContext, op: OpOf<"freeze.set">, tx: Tx) {
    const review = this.openReview(op.reviewId);
    this.requireRequesterOwner(ctx, review);
    const freeze: Freeze = {
      id: this.opts.newId(),
      reviewId: op.reviewId,
      scope: op.scope,
      agentIds: op.scope === "room" ? [] : op.agentIds.filter((id) => id !== review.requesterAgentId),
      paths: op.paths,
      createdAt: ctx.now,
    };
    tx.put("freezes", freeze.id, freeze);
    tx.emit({ type: "freeze.set", freeze });
    return { freezeId: freeze.id };
  }

  private freezeClear(ctx: OpContext, reviewId: string, tx: Tx) {
    const review = this.state.reviews.get(reviewId);
    if (!review) fail("not_found", `review ${reviewId} not found`);
    this.requireRequesterOwner(ctx, review);
    const targets = [...this.state.freezes.values()].filter((f) => f.reviewId === reviewId);
    for (const f of targets) {
      tx.del("freezes", f.id);
      tx.emit({ type: "freeze.cleared", freezeId: f.id, reviewId });
    }
    return { cleared: targets.map((f) => f.id) };
  }

  // ---------------------------------------------------------------- expiry

  /** Time-based transitions: agents going offline and locks expiring. Call periodically. */
  tick(now: number): ApplyResult {
    const tx = new Tx(this.state, null, now);

    for (const agent of this.state.agents.values()) {
      if (agent.status !== "offline" && now - agent.lastSeenAt > this.opts.agentOfflineMs) {
        const next: Agent = { ...agent, status: "offline" };
        tx.put("agents", agent.id, next);
        tx.emit({ type: "agent.updated", agent: next });
      }
    }

    const byAgent = new Map<string, { expired: string[]; clean: string[]; gone: string[] }>();
    const bucket = (id: string) => {
      let b = byAgent.get(id);
      if (!b) byAgent.set(id, (b = { expired: [], clean: [], gone: [] }));
      return b;
    };
    for (const lock of this.state.locks.values()) {
      const agent = this.state.agents.get(lock.agentId);
      if (!agent) {
        bucket(lock.agentId).gone.push(lock.path);
        continue;
      }
      if (agent.status === "offline" && now - agent.lastSeenAt > this.opts.lockStaleMs) {
        bucket(lock.agentId).expired.push(lock.path);
        continue;
      }
      const inDiff = this.state.diffs.get(lock.agentId)?.files.some((f) => f.path === lock.path || f.oldPath === lock.path);
      if (!inDiff && now - lock.renewedAt > this.opts.lockCleanGraceMs) bucket(lock.agentId).clean.push(lock.path);
    }
    for (const [agentId, b] of byAgent) {
      this.releaseLocks(agentId, b.gone, "agent_removed", tx);
      this.releaseLocks(agentId, b.expired, "expired", tx);
      this.releaseLocks(agentId, b.clean, "clean", tx);
    }

    return { ok: true, events: tx.events, changes: tx.changes };
  }

  /** Earliest time at which `tick` could change something, or null if nothing is pending. */
  nextDeadline(): number | null {
    let next = Infinity;
    for (const a of this.state.agents.values()) {
      if (a.status !== "offline") next = Math.min(next, a.lastSeenAt + this.opts.agentOfflineMs + 1);
    }
    for (const l of this.state.locks.values()) {
      const a = this.state.agents.get(l.agentId);
      if (!a) return 0;
      const inDiff = this.state.diffs.get(l.agentId)?.files.some((f) => f.path === l.path || f.oldPath === l.path);
      if (!inDiff) next = Math.min(next, l.renewedAt + this.opts.lockCleanGraceMs + 1);
      if (a.status === "offline") next = Math.min(next, a.lastSeenAt + this.opts.lockStaleMs + 1);
    }
    return next === Infinity ? null : next;
  }
}
