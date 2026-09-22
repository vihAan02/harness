import { watch, type FSWatcher } from "node:fs";
import type { AgentEvent, AgentStatus, DiffFile, HookDecision, Message, RoomEvent, ToolIntentKind, Vendor } from "@mp/protocol";
import { OPEN_REVIEW_STATUSES } from "@mp/protocol";
import { loadRepoConfig, RepoConfig } from "./config.ts";
import { ClaudeHost, type ClaudeHostOptions } from "./claude.ts";
import { computeLiveDiff } from "./diff.ts";
import { actorLabel, formatInbox, formatStatusTable } from "./format.ts";
import { repoInfo } from "./git.ts";
import { Home, randomId, type Identity, type LocalAgent, type RoomRecord } from "./home.ts";
import { markDelivered, pendingMessages } from "./inbox.ts";
import { formatInvite, parseInvite } from "./invite.ts";
import { OfflineError, OpFailedError, type RoomLink } from "./link.ts";
import { decidePreEdit, resolveReal, type Checkout } from "./policy.ts";
import { RelayClient } from "./relay-client.ts";
import { runTool, type ToolResult } from "./tools.ts";
import { createAgentWorktree, removeAgentWorktree, slugify } from "./worktrees.ts";

export class DaemonError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface DaemonOptions {
  home: Home | string;
  /** How to connect to a room. Defaults to a RelayClient over WebSocket. */
  linkFactory?: (room: RoomRecord, identity: Identity) => RoomLink;
  fetch?: typeof fetch;
  diffDebounceMs?: number;
  statusDebounceMs?: number;
  heartbeatMs?: number;
  holdTimeoutMs?: number;
  streamFlushMs?: number;
  connectTimeoutMs?: number;
  /** Watch worktrees for changes (off in tests, which refresh explicitly). */
  watch?: boolean;
  /** `git fetch` the base branch before creating a worktree. */
  fetchOnCreate?: boolean;
  /** How long a message pushed to a live feed may go unacknowledged before hooks deliver it again. */
  feedAckTimeoutMs?: number;
  /** Claude Code adapter settings (how to run mp-mcp, the claude binary, transcript polling). */
  claude?: ClaudeHostOptions;
}

/** A hook call, already mapped to vendor-neutral terms by an adapter. */
export interface HookInput {
  agentId?: string;
  /** Used to find the agent when agentId isn't known (hooks report the session's cwd). */
  cwd?: string;
  kind: ToolIntentKind;
  tool: string;
  paths?: string[];
  command?: string;
}

interface AgentRuntime {
  watcher?: FSWatcher;
  diffTimer?: ReturnType<typeof setTimeout>;
  diffChain: Promise<void>;
  lastDiffKey?: string;
  warned: Set<string>;
  streamBuf: AgentEvent[];
  streamTimer?: ReturnType<typeof setTimeout>;
  sentStatus?: AgentStatus;
  wantStatus: AgentStatus;
  statusTimer?: ReturnType<typeof setTimeout>;
  /** Live push subscribers (the MCP server's channel feed). */
  feeds: Set<(messages: FeedMessage[]) => void>;
  /** Messages pushed to a feed but not yet acknowledged, with their expiry. Hooks skip these. */
  inflight: Map<string, number>;
}

/** A room message as pushed to an agent's live feed. */
export interface FeedMessage {
  id: string;
  threadId: string;
  kind: Message["kind"];
  body: string;
  urgent: boolean;
  replyTo?: string;
  from: { type: "agent" | "member"; id: string; label: string };
  createdAt: number;
}

interface RoomRuntime {
  record: RoomRecord;
  link: RoomLink;
  offs: (() => void)[];
  /** Agents removed while offline; removed from the relay on reconnect. */
  tombstones: Set<string>;
}

type Waiter = { match: (e: RoomEvent) => boolean; resolve: (e: RoomEvent | null) => void };

const MAX_WIRE_FILES = 2000;
const MAX_WIRE_HUNKS = 1000;
const MAX_WIRE_BYTES = 900_000;

function unref(t: { unref?: () => void } | undefined): void {
  t?.unref?.();
}

/**
 * mp-daemon's core. One per machine: it owns room connections, agent worktrees, hook decisions,
 * live diffs, streams, inboxes and the mp_* tools. The HTTP server (server.ts) is a thin shell over this.
 */
export class Daemon {
  readonly home: Home;
  identity!: Identity;
  private readonly opts: Required<Omit<DaemonOptions, "home" | "linkFactory" | "fetch" | "claude">> & Pick<DaemonOptions, "linkFactory" | "fetch">;
  /** The Claude Code adapter: plugin hooks, transcript streaming, launch specs. */
  readonly claude: ClaudeHost;
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly agents = new Map<string, LocalAgent>();
  private readonly runtime = new Map<string, AgentRuntime>();
  private readonly configs = new Map<string, RepoConfig>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private saving: Promise<void> = Promise.resolve();

  constructor(opts: DaemonOptions) {
    this.home = typeof opts.home === "string" ? new Home(opts.home) : opts.home;
    this.claude = new ClaudeHost(this, opts.claude);
    this.opts = {
      diffDebounceMs: 400,
      statusDebounceMs: 750,
      heartbeatMs: 15_000,
      holdTimeoutMs: 240_000,
      streamFlushMs: 250,
      connectTimeoutMs: 10_000,
      watch: true,
      fetchOnCreate: true,
      feedAckTimeoutMs: 30_000,
      linkFactory: opts.linkFactory,
      fetch: opts.fetch,
      ...Object.fromEntries(Object.entries(opts).filter(([k, v]) => v !== undefined && k !== "claude")),
    } as Daemon["opts"];
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    await this.home.ensure();
    this.identity = await this.home.identity();
    for (const agent of await this.home.agents()) {
      this.agents.set(agent.id, agent);
      this.startRuntime(agent);
    }
    for (const record of await this.home.rooms()) this.connectRoom(record);
    this.heartbeat = setInterval(() => void this.sendHeartbeats(), this.opts.heartbeatMs);
    unref(this.heartbeat);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.claude.stop();
    for (const id of this.runtime.keys()) this.stopRuntime(id);
    for (const room of this.rooms.values()) {
      for (const off of room.offs) off();
      room.link.close();
    }
    this.rooms.clear();
    for (const set of this.waiters.values()) for (const w of set) w.resolve(null);
    this.waiters.clear();
    await this.saving;
  }

  // ------------------------------------------------------------------ rooms

  private makeLink(record: RoomRecord): RoomLink {
    if (this.opts.linkFactory) return this.opts.linkFactory(record, this.identity);
    return new RelayClient({
      relayUrl: record.relayUrl,
      roomId: record.roomId,
      secret: record.secret,
      member: { id: this.identity.memberId, name: this.identity.name },
      deviceId: this.identity.deviceId,
    });
  }

  private connectRoom(record: RoomRecord): RoomRuntime {
    const existing = this.rooms.get(record.roomId);
    if (existing) return existing;
    const link = this.makeLink(record);
    const room: RoomRuntime = { record, link, offs: [], tombstones: new Set() };
    room.offs.push(
      link.on("status", (up) => {
        if (up) void this.onConnected(room);
      }),
      link.on("event", (e) => this.onEvent(record.roomId, e)),
      link.on("fatal", (msg) => console.error(`[mp] room ${record.roomId}: ${msg}`)),
    );
    this.rooms.set(record.roomId, room);
    link.start();
    return room;
  }

  private waitConnected(link: RoomLink): Promise<void> {
    if (link.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        offs.forEach((f) => f());
        reject(new DaemonError(504, "relay_unreachable", "could not connect to the relay"));
      }, this.opts.connectTimeoutMs);
      unref(timer);
      const offs = [
        link.on("status", (up) => {
          if (!up) return;
          clearTimeout(timer);
          offs.forEach((f) => f());
          resolve();
        }),
        link.on("fatal", (msg) => {
          clearTimeout(timer);
          offs.forEach((f) => f());
          reject(new DaemonError(401, "unauthorized", `the relay refused this room: ${msg}`));
        }),
      ];
    });
  }

  private async addRoom(repoPath: string, invite: { relayUrl: string; roomId: string; secret: string }) {
    const info = await repoInfo(repoPath);
    const rooms = await this.home.rooms();
    const clash = rooms.find((r) => r.repoKey === info.repoKey && r.roomId !== invite.roomId);
    if (clash) throw new DaemonError(409, "already_joined", `this repo is already in room ${clash.roomId}`);
    const record: RoomRecord = { ...invite, repoKey: info.repoKey, joinedAt: Date.now() };
    if (!rooms.some((r) => r.roomId === record.roomId)) await this.home.saveRooms([...rooms, record]);
    const room = this.connectRoom(record);
    try {
      await this.waitConnected(room.link);
    } catch (err) {
      if (err instanceof DaemonError && err.code === "unauthorized") await this.forgetRoom(record.roomId);
      throw err;
    }
    return { roomId: record.roomId, repoKey: record.repoKey, invite: formatInvite(record) };
  }

  /** Creates a room on the relay for this repo and joins it. */
  async createRoom(input: { repoPath: string; relayUrl: string }) {
    const info = await repoInfo(input.repoPath);
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(`${input.relayUrl.replace(/\/+$/, "")}/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: info.repoKey }),
    });
    if (res.status !== 201) throw new DaemonError(502, "relay_error", `relay refused to create a room (${res.status})`);
    const { roomId, secret } = (await res.json()) as { roomId: string; secret: string };
    return this.addRoom(input.repoPath, { relayUrl: input.relayUrl.replace(/\/+$/, ""), roomId, secret });
  }

  async joinRoom(input: { repoPath: string; invite: string }) {
    let invite;
    try {
      invite = parseInvite(input.invite);
    } catch (err) {
      throw new DaemonError(400, "bad_invite", (err as Error).message);
    }
    return this.addRoom(input.repoPath, invite);
  }

  private async forgetRoom(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (room) {
      for (const off of room.offs) off();
      room.link.close();
      this.rooms.delete(roomId);
    }
    await this.home.saveRooms((await this.home.rooms()).filter((r) => r.roomId !== roomId));
  }

  listRooms() {
    return [...this.rooms.values()].map((r) => ({
      roomId: r.record.roomId,
      repoKey: r.record.repoKey,
      relayUrl: r.record.relayUrl,
      connected: r.link.connected,
      invite: formatInvite(r.record),
    }));
  }

  private room(roomId: string): RoomRuntime {
    const room = this.rooms.get(roomId);
    if (!room) throw new DaemonError(404, "no_room", `not in room ${roomId}`);
    return room;
  }

  /** The link for a room, for callers (the IDE service) that read the mirror directly. */
  link(roomId: string): RoomLink {
    return this.room(roomId).link;
  }

  roomStatus(roomId: string) {
    const { link } = this.room(roomId);
    const rows = link.mirror.status();
    return { connected: link.connected, rows, table: formatStatusTable(rows, link.mirror.state) };
  }

  private async onConnected(room: RoomRuntime): Promise<void> {
    for (const id of room.tombstones) {
      try {
        await room.link.request({ op: "agent.remove", agentId: id });
      } catch {
        // Already gone, or we're offline again; either way try again next time.
        continue;
      }
      room.tombstones.delete(id);
    }
    for (const agent of this.agents.values()) {
      if (agent.roomId !== room.record.roomId) continue;
      await this.register(agent).catch((err) => console.error(`[mp] could not register ${agent.id}`, err));
      const rt = this.runtime.get(agent.id);
      if (rt) rt.lastDiffKey = undefined;
      this.scheduleDiff(agent.id, 0);
      this.pumpFeeds(agent);
    }
  }

  private async register(agent: LocalAgent): Promise<void> {
    const rt = this.runtime.get(agent.id);
    const status = rt?.wantStatus ?? "idle";
    await this.room(agent.roomId).link.request({
      op: "agent.upsert",
      agent: {
        id: agent.id,
        deviceId: this.identity.deviceId,
        vendor: agent.vendor,
        name: agent.name,
        status,
        branch: agent.branch,
        baseBranch: agent.baseBranch,
        ...(agent.task ? { task: agent.task } : {}),
      },
    });
    if (rt) rt.sentStatus = status;
  }

  private async sendHeartbeats(): Promise<void> {
    for (const room of this.rooms.values()) {
      if (!room.link.connected) continue;
      const agentIds = [...this.agents.values()].filter((a) => a.roomId === room.record.roomId).map((a) => a.id);
      if (!agentIds.length) continue;
      await room.link.request({ op: "heartbeat", agentIds }).catch(async (err) => {
        // The relay forgot one of our agents (e.g. removed from another device): re-register everyone.
        if (err instanceof OpFailedError && err.code === "not_found") await this.onConnected(room);
      });
    }
  }

  // ------------------------------------------------------------------ events & waiting

  private onEvent(roomId: string, e: RoomEvent): void {
    if (e.type === "message.posted") {
      for (const agent of this.agents.values()) if (agent.roomId === roomId) this.pumpFeeds(agent);
    }
    const set = this.waiters.get(roomId);
    if (!set) return;
    for (const w of [...set]) {
      if (w.match(e)) {
        set.delete(w);
        w.resolve(e);
      }
    }
  }

  private waitForEvent(roomId: string, match: (e: RoomEvent) => boolean, timeoutMs: number): Promise<RoomEvent | null> {
    return new Promise((resolve) => {
      let set = this.waiters.get(roomId);
      if (!set) this.waiters.set(roomId, (set = new Set()));
      const waiter: Waiter = {
        match,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      };
      const timer = setTimeout(() => {
        set!.delete(waiter);
        resolve(null);
      }, timeoutMs);
      unref(timer);
      set.add(waiter);
    });
  }

  private freezeActive(link: RoomLink, reviewId: string): boolean {
    const state = link.mirror.state;
    const review = state.reviews.get(reviewId);
    if (!review || !OPEN_REVIEW_STATUSES.includes(review.status) || review.status === "queued") return false;
    return [...state.freezes.values()].some((f) => f.reviewId === reviewId);
  }

  private async waitForFreezeClear(roomId: string, reviewId: string, timeoutMs: number): Promise<boolean> {
    const link = this.room(roomId).link;
    const deadline = Date.now() + timeoutMs;
    while (this.freezeActive(link, reviewId)) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await this.waitForEvent(
        roomId,
        (e) => (e.type === "freeze.cleared" && e.reviewId === reviewId) || (e.type === "review.updated" && e.review.id === reviewId),
        left,
      );
    }
    return true;
  }

  private async waitForReply(roomId: string, messageId: string, timeoutMs: number): Promise<Message | null> {
    const link = this.room(roomId).link;
    const existing = [...link.mirror.state.messages.values()].find((m) => m.replyTo === messageId);
    if (existing) return existing;
    const e = await this.waitForEvent(roomId, (ev) => ev.type === "message.posted" && ev.message.replyTo === messageId, timeoutMs);
    return e?.type === "message.posted" ? e.message : null;
  }

  // ------------------------------------------------------------------ agents

  listAgents(): LocalAgent[] {
    return [...this.agents.values()];
  }

  getAgent(id: string): LocalAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new DaemonError(404, "no_agent", `no local agent ${id}`);
    return agent;
  }

  /** Finds the local agent by id, or by the worktree containing `cwd`. */
  async resolveAgent(input: { agentId?: string; cwd?: string }): Promise<LocalAgent | undefined> {
    if (input.agentId) return this.agents.get(input.agentId);
    if (!input.cwd) return undefined;
    const cwd = await resolveReal(input.cwd);
    return [...this.agents.values()]
      .filter((a) => cwd === a.worktree || cwd.startsWith(a.worktree + "/"))
      .sort((a, b) => b.worktree.length - a.worktree.length)[0];
  }

  private async persistAgents(): Promise<void> {
    const snapshot = [...this.agents.values()];
    this.saving = this.saving.then(() => this.home.saveAgents(snapshot)).catch((err) => console.error("[mp] saving agents failed", err));
    await this.saving;
  }

  private async configFor(agent: LocalAgent): Promise<RepoConfig> {
    // The agent's own worktree is where its view of .multiplayer.json lives.
    const cached = this.configs.get(agent.worktree);
    if (cached) return cached;
    const config = await loadRepoConfig(agent.worktree).catch((err) => {
      console.error(`[mp] ${agent.worktree}: ${(err as Error).message}; using defaults`);
      return RepoConfig.parse({});
    });
    this.configs.set(agent.worktree, config);
    return config;
  }

  async createAgent(input: { repoPath: string; name: string; vendor: Vendor; task?: string; baseBranch?: string }): Promise<LocalAgent> {
    const info = await repoInfo(input.repoPath);
    const record = (await this.home.rooms()).find((r) => r.repoKey === info.repoKey);
    if (!record) throw new DaemonError(409, "no_room", "create or join a room for this repo first");
    const room = this.connectRoom(record);
    const config = await loadRepoConfig(info.root).catch(() => RepoConfig.parse({}));
    const baseBranch = input.baseBranch ?? config.baseBranch ?? info.defaultBase;
    const agentSlug = slugify(input.name);
    const created = await createAgentWorktree({
      repoRoot: info.root,
      repoKey: info.repoKey,
      worktreesDir: this.home.worktreesDir,
      memberSlug: slugify(this.identity.name, "me"),
      agentSlug,
      baseBranch,
      fetch: this.opts.fetchOnCreate,
    });
    const agent: LocalAgent = {
      id: `${agentSlug}-${randomId(3)}`,
      roomId: record.roomId,
      repoKey: info.repoKey,
      repoRoot: info.root,
      worktree: await resolveReal(created.worktree),
      branch: created.branch,
      baseBranch,
      baseRef: created.baseRef,
      vendor: input.vendor,
      name: input.name,
      ...(input.task ? { task: input.task } : {}),
      createdAt: Date.now(),
      delivered: [],
    };
    this.agents.set(agent.id, agent);
    await this.persistAgents();
    this.startRuntime(agent);
    if (room.link.connected) {
      await this.register(agent).catch((err) => console.error(`[mp] could not register ${agent.id}`, err));
      this.scheduleDiff(agent.id, 0);
    }
    return agent;
  }

  async removeAgent(id: string, opts: { keepWorktree?: boolean; force?: boolean } = {}): Promise<void> {
    const agent = this.getAgent(id);
    if (!opts.keepWorktree) {
      try {
        await removeAgentWorktree({ repoRoot: agent.repoRoot, worktree: agent.worktree, force: opts.force ?? false });
      } catch (err) {
        throw new DaemonError(409, "worktree_dirty", `${(err as Error).message}. Commit or discard the changes, or pass force.`);
      }
    }
    this.stopRuntime(id);
    this.agents.delete(id);
    await this.persistAgents();
    const room = this.rooms.get(agent.roomId);
    if (!room) return;
    try {
      await room.link.request({ op: "agent.remove", agentId: id });
    } catch (err) {
      if (!(err instanceof OpFailedError && err.code === "not_found")) room.tombstones.add(id);
    }
  }

  private startRuntime(agent: LocalAgent): void {
    if (this.runtime.has(agent.id)) return;
    const rt: AgentRuntime = {
      diffChain: Promise.resolve(),
      warned: new Set(),
      streamBuf: [],
      wantStatus: "idle",
      feeds: new Set(),
      inflight: new Map(),
    };
    this.runtime.set(agent.id, rt);
    if (this.opts.watch) {
      try {
        rt.watcher = watch(agent.worktree, { recursive: true }, (_event, filename) => {
          const f = filename ? String(filename) : "";
          if (f === ".git" || f.startsWith(".git/") || f.startsWith("node_modules/")) return;
          this.scheduleDiff(agent.id);
        });
        rt.watcher.on("error", (err) => console.error(`[mp] watcher for ${agent.id} failed`, err));
      } catch (err) {
        console.error(`[mp] cannot watch ${agent.worktree}`, err);
      }
    }
  }

  private stopRuntime(id: string): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    rt.watcher?.close();
    for (const t of [rt.diffTimer, rt.streamTimer, rt.statusTimer]) if (t) clearTimeout(t);
    this.runtime.delete(id);
  }

  private setStatus(agent: LocalAgent, status: AgentStatus): void {
    const rt = this.runtime.get(agent.id);
    if (!rt) return;
    rt.wantStatus = status;
    if (rt.statusTimer) return;
    // Coalesce: a pre/post pair flips editing→thinking within milliseconds; only publish where it settles.
    rt.statusTimer = setTimeout(() => {
      rt.statusTimer = undefined;
      const link = this.rooms.get(agent.roomId)?.link;
      if (!link?.connected || rt.sentStatus === rt.wantStatus) return;
      const next = rt.wantStatus;
      void this.register(agent).then(
        () => (rt.sentStatus = next),
        () => undefined,
      );
    }, this.opts.statusDebounceMs);
    unref(rt.statusTimer);
  }

  // ------------------------------------------------------------------ live diffs

  scheduleDiff(agentId: string, delayMs = this.opts.diffDebounceMs): void {
    const rt = this.runtime.get(agentId);
    if (!rt) return;
    if (rt.diffTimer) clearTimeout(rt.diffTimer);
    rt.diffTimer = setTimeout(() => {
      rt.diffTimer = undefined;
      void this.refreshDiff(agentId);
    }, delayMs);
    unref(rt.diffTimer);
  }

  /** Recomputes the agent's live diff and publishes it if it changed. Serialized per agent. */
  refreshDiff(agentId: string): Promise<void> {
    const rt = this.runtime.get(agentId);
    if (!rt) return Promise.resolve();
    rt.diffChain = rt.diffChain.then(() => this.publishDiff(agentId)).catch((err) => {
      console.error(`[mp] diff for ${agentId} failed`, err);
    });
    return rt.diffChain;
  }

  private async publishDiff(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    const rt = this.runtime.get(agentId);
    const link = agent ? this.rooms.get(agent.roomId)?.link : undefined;
    if (!agent || !rt || !link) return;
    const config = await this.configFor(agent);
    const { mergeBase, files } = await computeLiveDiff(agent.worktree, agent.baseRef, { includePatch: config.shareLiveDiffs });
    const wire = fitForWire(files);
    const key = JSON.stringify([mergeBase, wire]);
    if (key === rt.lastDiffKey || !link.connected) return;
    await link.request({ op: "diff.set", agentId, baseRef: mergeBase, files: wire }).then(
      () => (rt.lastDiffKey = key),
      (err) => {
        if (!(err instanceof OfflineError)) throw err;
      },
    );
  }

  /** Waits until pending diff refreshes and stream flushes are done (for tests and shutdown). */
  async settle(): Promise<void> {
    for (const [id, rt] of this.runtime) {
      if (rt.diffTimer) {
        clearTimeout(rt.diffTimer);
        rt.diffTimer = undefined;
        void this.refreshDiff(id);
      }
      if (rt.streamTimer) {
        clearTimeout(rt.streamTimer);
        rt.streamTimer = undefined;
        await this.flushStream(id);
      }
      await rt.diffChain;
    }
  }

  // ------------------------------------------------------------------ streams

  async pushStream(agentId: string, events: AgentEvent[]): Promise<void> {
    const agent = this.getAgent(agentId);
    const rt = this.runtime.get(agentId);
    if (!rt || !(await this.configFor(agent)).shareStreams) return;
    rt.streamBuf.push(...events);
    if (rt.streamBuf.length > 1000) rt.streamBuf.splice(0, rt.streamBuf.length - 1000);
    if (!rt.streamTimer) {
      rt.streamTimer = setTimeout(() => {
        rt.streamTimer = undefined;
        void this.flushStream(agentId);
      }, this.opts.streamFlushMs);
      unref(rt.streamTimer);
    }
  }

  private async flushStream(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    const rt = this.runtime.get(agentId);
    const link = agent ? this.rooms.get(agent.roomId)?.link : undefined;
    if (!agent || !rt || !link?.connected) return;
    while (rt.streamBuf.length) {
      const batch = rt.streamBuf.splice(0, 200);
      try {
        await link.request({ op: "stream.push", agentId, events: batch });
      } catch (err) {
        if (err instanceof OfflineError) {
          rt.streamBuf.unshift(...batch);
          return;
        }
        console.error(`[mp] stream push for ${agentId} failed`, err);
      }
    }
  }

  // ------------------------------------------------------------------ hooks

  private others(agent: LocalAgent): Checkout[] {
    const out: Checkout[] = [{ path: agent.repoRoot, label: `the main checkout (${agent.repoRoot})` }];
    for (const a of this.agents.values()) {
      if (a.id !== agent.id && a.repoKey === agent.repoKey) out.push({ path: a.worktree, label: `${a.name}'s worktree` });
    }
    return out;
  }

  async preToolUse(input: HookInput): Promise<HookDecision> {
    const agent = await this.resolveAgent(input);
    if (!agent) return { decision: "allow" };
    const room = this.rooms.get(agent.roomId);
    if (!room) return { decision: "allow" };

    if (input.kind === "edit") {
      this.setStatus(agent, "editing");
      const rt = this.runtime.get(agent.id);
      return decidePreEdit(
        {
          link: room.link,
          config: await this.configFor(agent),
          agent,
          others: this.others(agent),
          warned: rt?.warned ?? new Set(),
          holdTimeoutMs: this.opts.holdTimeoutMs,
          reregister: () => this.register(agent),
          waitForFreezeClear: (reviewId, ms) => this.waitForFreezeClear(agent.roomId, reviewId, ms),
        },
        input.paths ?? [],
      );
    }
    if (input.kind === "bash") this.setStatus(agent, "running");
    // Shell commands pass for now; the critical command gate (M6) plugs in here.
    return { decision: "allow" };
  }

  async postToolUse(input: HookInput): Promise<{ additionalContext?: string }> {
    const agent = await this.resolveAgent(input);
    if (!agent) return {};
    this.setStatus(agent, "thinking");
    if (input.kind === "edit" || input.kind === "bash") this.scheduleDiff(agent.id);
    const messages = await this.takeInbox(agent);
    return messages.length ? { additionalContext: formatInbox(messages, this.room(agent.roomId).link.mirror.state) } : {};
  }

  /** Pending messages for the agent, minus ones pushed to a feed and still awaiting acknowledgement. */
  private pendingFor(agent: LocalAgent): Message[] {
    const room = this.rooms.get(agent.roomId);
    if (!room) return [];
    const rt = this.runtime.get(agent.id);
    const now = Date.now();
    const skip = new Set(agent.delivered);
    for (const [id, until] of rt?.inflight ?? []) {
      if (until > now) skip.add(id);
      else rt!.inflight.delete(id);
    }
    return pendingMessages(room.link.mirror.state, agent.id, skip);
  }

  private async takeInbox(agent: LocalAgent): Promise<Message[]> {
    const pending = this.pendingFor(agent);
    if (pending.length) {
      agent.delivered = markDelivered(agent.delivered, pending.map((m) => m.id));
      await this.persistAgents();
    }
    return pending;
  }

  // ------------------------------------------------------------------ helpers for vendor adapters

  /** Publishes an agent's status (debounced), e.g. from a vendor hook. */
  setAgentStatus(agentId: string, status: AgentStatus): void {
    const agent = this.agents.get(agentId);
    if (agent) this.setStatus(agent, status);
  }

  /**
   * Takes pending messages for the agent (marking them delivered) and formats them as context.
   * With `onlyNeedsReply`, only questions, handoffs and urgent messages are taken.
   */
  async inboxContext(agentId: string, opts: { onlyNeedsReply?: boolean } = {}): Promise<string | undefined> {
    const agent = this.getAgent(agentId);
    const room = this.rooms.get(agent.roomId);
    if (!room) return undefined;
    let pending = this.pendingFor(agent);
    if (opts.onlyNeedsReply) pending = pending.filter((m) => m.urgent || m.kind === "question" || m.kind === "handoff");
    if (!pending.length) return undefined;
    agent.delivered = markDelivered(agent.delivered, pending.map((m) => m.id));
    await this.persistAgents();
    return formatInbox(pending, room.link.mirror.state);
  }

  /** What an agent is told when its session starts: who it is, the room right now, and how to begin. */
  async briefing(agentId: string): Promise<string> {
    const agent = this.getAgent(agentId);
    const room = this.rooms.get(agent.roomId);
    const lines = [
      `You are "${agent.name}" (agent id ${agent.id}) in the multiplayer room for ${agent.repoKey}, working in your own worktree on branch ${agent.branch} (based on ${agent.baseRef}).`,
      ...(agent.task ? [`Your task: ${agent.task}`] : []),
    ];
    if (room?.link.connected) {
      lines.push("", "The room right now:", formatStatusTable(room.link.mirror.status(), room.link.mirror.state));
    } else {
      lines.push("", "The room is unreachable right now; coordination resumes when it's back.");
    }
    lines.push("", "Before your first edit, publish your plan with mp_plan and claim the area you'll own with mp_claim.");
    const inbox = await this.inboxContext(agentId);
    if (inbox) lines.push("", inbox);
    return lines.join("\n");
  }

  // ------------------------------------------------------------------ live feed

  /**
   * Subscribes to messages for an agent as they arrive (used by the MCP server to push them into a
   * Claude session over channels). Messages count as delivered only once acknowledged with `ackFeed`;
   * unacknowledged ones fall back to hook delivery after `feedAckTimeoutMs`.
   */
  subscribeFeed(agentId: string, send: (messages: FeedMessage[]) => void): () => void {
    const agent = this.getAgent(agentId);
    const rt = this.runtime.get(agentId);
    if (!rt) throw new DaemonError(404, "no_agent", `agent ${agentId} is not running`);
    rt.feeds.add(send);
    this.pumpFeeds(agent);
    return () => rt.feeds.delete(send);
  }

  async ackFeed(agentId: string, ids: readonly string[]): Promise<void> {
    const agent = this.getAgent(agentId);
    const rt = this.runtime.get(agentId);
    for (const id of ids) rt?.inflight.delete(id);
    agent.delivered = markDelivered(agent.delivered, ids);
    await this.persistAgents();
  }

  private pumpFeeds(agent: LocalAgent): void {
    const rt = this.runtime.get(agent.id);
    const room = this.rooms.get(agent.roomId);
    if (!rt?.feeds.size || !room) return;
    const pending = this.pendingFor(agent);
    if (!pending.length) return;
    const until = Date.now() + this.opts.feedAckTimeoutMs;
    for (const m of pending) rt.inflight.set(m.id, until);
    const state = room.link.mirror.state;
    const out: FeedMessage[] = pending.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      kind: m.kind,
      body: m.body,
      urgent: m.urgent === true,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      from: { ...m.from, label: actorLabel(state, m.from) },
      createdAt: m.createdAt,
    }));
    // One subscriber is enough; if several are attached (e.g. a restarted MCP server), the newest wins.
    const newest = [...rt.feeds].at(-1)!;
    try {
      newest(out);
    } catch (err) {
      for (const m of pending) rt.inflight.delete(m.id);
      console.error(`[mp] feed push for ${agent.id} failed`, err);
    }
  }

  // ------------------------------------------------------------------ tools

  async tool(agentId: string, name: string, args: unknown): Promise<ToolResult> {
    const agent = this.getAgent(agentId);
    const room = this.room(agent.roomId);
    try {
      return await runTool(
        {
          link: room.link,
          agent,
          takeInbox: () => this.takeInbox(agent),
          waitForReply: (messageId, ms) => this.waitForReply(agent.roomId, messageId, ms),
        },
        name,
        args,
      );
    } catch (err) {
      if (err instanceof OfflineError) throw new DaemonError(503, "offline", "the room is unreachable right now; try again shortly");
      if (err instanceof OpFailedError) throw new DaemonError(err.code === "not_found" ? 404 : 400, err.code, err.message);
      throw err;
    }
  }
}

/** Keeps a diff within the relay's message and schema limits by dropping patch text first. */
export function fitForWire(files: DiffFile[]): DiffFile[] {
  let out = files.slice(0, MAX_WIRE_FILES).map((f) => (f.hunks.length > MAX_WIRE_HUNKS ? { ...f, hunks: f.hunks.slice(0, MAX_WIRE_HUNKS), truncated: true } : f));
  if (JSON.stringify(out).length > MAX_WIRE_BYTES) {
    out = out.map(({ patch: _p, ...f }) => ({ ...f, ...(_p !== undefined ? { truncated: true } : {}) }));
  }
  return out;
}
