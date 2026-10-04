// The vendor boundary (D-17; docs/agent-adapters.md §2, §3). Everything harnessd knows about an
// agent session goes through these types; vendor names, SDK types and quirks stay inside each
// adapter's own module.
import type { ReadPolicy } from './readpolicy.ts';

export type SessionStatus = 'starting' | 'working' | 'idle' | 'waiting' | 'errored' | 'ended';

/** What a vendor can do, at a given version. Weaker capabilities lower confidence or refuse the run; never pretend. */
export type Capabilities = {
  canCaptureReads: boolean;
  canDenyToolCalls: boolean;
  canInjectTurn: boolean;
  canResume: boolean;
  supportsMCP: boolean;
  supportsHooks: boolean;
  readCaptureFidelity: 'tool-observed' | 'command-parsed' | 'none';
  canInjectBetweenTools: boolean;
  canSandboxReads: boolean;
  hooksFailClosed: { preToolUse: boolean; postToolUse: boolean; stop: boolean };
  authModes: Array<'api-key' | 'subscription' | 'cloud-provider'>;
};

/**
 * An API key or provider token from a pay-as-you-go account, never a subscription login (D-56, D-87).
 * `baseUrl` points the vendor at another endpoint that speaks its API: a configured provider, or a test
 * double. `scheme` is how that endpoint wants the key: `x-api-key` (the default) or a bearer token.
 */
export type Auth = { mode: 'api-key'; apiKey: string; scheme?: 'x-api-key' | 'bearer'; baseUrl?: string };

/** USD per million tokens, from the local config (D-87). Used when the vendor can't price a model itself. */
export type Prices = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

/**
 * The model a session runs on, and what the vendor needs to know about it (D-87). Vendor-neutral: each
 * adapter maps these onto its own settings. `background` is the model for the vendor's own auxiliary
 * calls (summaries, titles); `stripExperimental` drops request fields that only the vendor's first-party
 * API accepts; `extraBody` is merged into every request (for example, to pin a router's provider).
 */
export type ModelConfig = {
  id: string;
  background?: string;
  contextTokens?: number;
  compactWindowTokens?: number;
  maxOutputTokens?: number;
  stripExperimental?: boolean;
  extraBody?: Record<string, unknown>;
  prices?: Record<string, Prices>;
};

/**
 * A parameter of a harness tool. Kept tiny on purpose: the shim's tools take short strings, string lists
 * and whole numbers such as a TTL or a timeout in seconds (protocol.md §6). `min`/`max` bound a number.
 */
export type ToolParam = { type: 'string' | 'string[]' | 'number'; description: string; optional?: boolean; maxLength?: number; min?: number; max?: number };
export type ToolResult = { text: string; isError?: boolean };
/** One agent-facing harness tool (D-15). Each maps onto a protocol command; harnessd supplies `run`. */
export type HarnessTool = {
  name: string;
  description: string;
  params: Record<string, ToolParam>;
  run: (args: Record<string, unknown>) => Promise<ToolResult>;
};

/** Everything an adapter needs to start one agent session for one task (agent-adapters.md §2). */
export type SessionSpec = {
  sessionId: string; // assigned by harnessd; becomes the vendor's session id where it can
  worktree: string; // the session's cwd, and the only tree it may write
  gitCommonDir: string; // the repo's shared .git: write-denied (D-50, D-60)
  configDir: string; // the agent's own vendor config dir (D-65); part of the resume key
  ports: { base: number; count: number } | null; // D-38, D-68
  env: Record<string, string>; // harness-set variables, such as the port block (D-38, D-68)
  secrets: Record<string, string>; // the task's allowlisted secrets, resolved by harnessd; never a reserved name (D-36, D-52, D-87)
  auth: Auth;
  instructions: string; // standing instructions + repo instruction files, for the system prompt (D-25, D-45)
  tools: HarnessTool[];
  model?: ModelConfig; // unset: the vendor's default model
  maxBudgetUsd?: number; // per session, against the cost the adapter reports (configured prices where given)
  readPolicy?: ReadPolicy; // what the agent may read (D-61, D-98); harnessd always sets it, real paths
  taskOpen?: () => boolean; // is the task still in progress? The Stop gate keeps the agent going only then (D-100). Unset: yes
  log?: (line: string) => void; // vendor stderr; never contains our options' secrets (none are passed as options)
};

/** The rendered text of one message for an agent; harnessd renders the envelope (D-25, protocol.md §8). */
export type EnvelopedMessage = {
  id: string;
  text: string;
  origin: 'peer' | 'coordinator' | 'human';
  /** `next`: the next safe boundary (default). `later`: only at turn end (coordination §3). */
  when?: 'next' | 'later';
};
export type Landed = 'between_tools' | 'new_turn' | 'stop_hook';
/** Resolves when the vendor confirms the message reached the model. */
export type DeliveryReceipt = { messageId: string; landed: Landed; deliveredAt: number };

export type ToolCategory = 'read' | 'search' | 'edit' | 'write' | 'shell' | 'mcp' | 'other';
export type ErrorKind = 'rate_limit' | 'billing' | 'auth' | 'sandbox' | 'hardening' | 'budget' | 'other';
/** Where a usage report's cost came from: configured prices, the vendor's list prices, or the vendor's guess for a model it doesn't know. */
export type CostBasis = 'config' | 'list' | 'unknown';

/** A file read the vendor's tools reported (0B item 1; D-88). Shell reads are parsed by harnessd, vendor-neutrally. */
export type ObservedRead = { path: string; source: 'read_tool' | 'search_hit'; confidence: 'high' | 'medium'; range?: { start: number; lines: number } };

/** The normalized stream every adapter produces (agent-adapters.md §3). Paths are relative to the worktree. */
export type Observation =
  | { kind: 'process.started'; pid: number }
  | { kind: 'session.init'; vendorSessionId: string; vendorVersion: string; model: string }
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'turn.started' }
  | { kind: 'turn.ended'; reason: string; isError: boolean; denied: number; deniedIds: string[] } // tool calls the permission rules refused this turn
  | { kind: 'tool.called'; toolUseId: string; tool: string; category: ToolCategory; paths?: string[]; command?: string }
  /** A post-tool hook ran for this call. Calls with a result and no hook are the missed-hook monitor's count (D-47, H-03). */
  | { kind: 'hook.seen'; toolUseId: string; tool: string; event: 'post' | 'post_failure' }
  | { kind: 'tool.result'; toolUseId: string; isError: boolean }
  | { kind: 'read.observed'; toolUseId: string; reads: ObservedRead[]; outside: string[] }
  /** A shell command the agent ran, for harnessd's best-effort read parsing (D-88). */
  | { kind: 'shell.ran'; toolUseId: string; command: string }
  | { kind: 'edit.observed'; paths: string[]; outside: string[] }
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number; costBasis: CostBasis; models: string[]; cumulative: true }
  | { kind: 'error'; error: ErrorKind; message: string }
  | { kind: 'delivery'; messageId: string; landed: Landed; deliveredAt: number }
  /** The Stop gate reached the vendor's continuation cap with notices still queued; they open the next turn (D-100). */
  | { kind: 'stop.capped'; pending: number }
  | { kind: 'ended'; reason: string };

/**
 * Where an adapter's hooks report to. `gate` runs before every tool call and returns a reason to
 * deny it, or null; the adapter uses it to hold tools until the session's hardening is verified.
 * `notices` runs after each batch of tool calls and returns queued notice text to attach to the
 * results, at most `maxChars` long (or null); what it returns counts as delivered (D-99). `stop` runs
 * when the agent is about to end its turn (`continued`: right after a Stop continuation) and returns
 * notice text to keep it going with, or null (D-100).
 */
export type HarnessHookSink = {
  observe: (o: Observation) => void;
  gate?: () => Promise<string | null>;
  notices?: (maxChars: number) => string | null;
  stop?: (continued: boolean) => string | null;
};

export interface SessionHandle {
  readonly id: string;
  readonly pid: number | null;
  readonly vendorSessionId: string | null;
}
export type VendorSessionRef = { vendorSessionId: string };

export interface AgentAdapter<PolicyBundle = unknown, HookBundle = unknown> {
  readonly vendor: string;
  /** The vendor version this adapter is pinned to, and the one installed; startSession refuses a mismatch (D-49). */
  version(): { pinned: string; installed: string };
  capabilities(version: string): Capabilities;
  startSession(spec: SessionSpec, firstMessage: EnvelopedMessage): Promise<SessionHandle>;
  resumeSession(ref: VendorSessionRef, spec: SessionSpec, message?: EnvelopedMessage): Promise<SessionHandle>;
  injectMessage(h: SessionHandle, msg: EnvelopedMessage): Promise<DeliveryReceipt>;
  /**
   * A high-priority harness notice (coordination.md §3), attached to the agent's context at the vendor's
   * earliest point: after its next batch of tool calls while a turn runs (`between_tools`). A notice too
   * long to attach, or for a session that isn't in a turn, is injected like any message and lands where
   * injection lands. When the agent is about to end its turn with notices queued and its task open, the
   * Stop gate keeps it going with them (`stop_hook`, D-100). One still queued when the turn ends opens the
   * next turn (`new_turn`), and one queued before another message is injected goes out ahead of it. Never
   * a landed notice, which waits for the sync (D-53, D-99).
   */
  queueNotice(h: SessionHandle, msg: EnvelopedMessage): Promise<DeliveryReceipt>;
  /** Takes back a queued notice not delivered yet, because a newer one replaced it; its receipt rejects. True if it was still queued. */
  withdrawNotice(h: SessionHandle, messageId: string): boolean;
  stopSession(h: SessionHandle, mode: 'graceful' | 'kill'): Promise<void>;
  /**
   * Holds the agent: while a reason is set, every tool call is denied with it (fail closed). harnessd holds
   * an agent while it syncs its branch, and while a sync conflict waits for the human (D-53).
   */
  setHold(h: SessionHandle, reason: string | null): void;
  getStatus(h: SessionHandle): SessionStatus;
  /** Pure: the vendor's permission and sandbox config for this session. */
  compilePermissions(spec: SessionSpec): PolicyBundle;
  setupHooks(spec: SessionSpec, sink: HarnessHookSink): HookBundle;
  observations(h: SessionHandle): AsyncIterable<Observation>;
}
