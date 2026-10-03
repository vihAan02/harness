// The vendor boundary (D-17; docs/agent-adapters.md §2, §3). Everything harnessd knows about an
// agent session goes through these types; vendor names, SDK types and quirks stay inside each
// adapter's own module.

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

/** API keys only in Phase 0 (D-56). `baseUrl` points the vendor at a test double; real runs leave it unset. */
export type Auth = { mode: 'api-key'; apiKey: string; baseUrl?: string };

/** A parameter of a harness tool. Kept tiny on purpose: the shim's tools take short strings (protocol.md §6). */
export type ToolParam = { type: 'string' | 'string[]'; description: string; optional?: boolean; maxLength?: number };
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
  env: Record<string, string>; // the ports and allowlisted secrets, already resolved by harnessd (D-36, D-52)
  auth: Auth;
  instructions: string; // standing instructions + repo instruction files, for the system prompt (D-25, D-45)
  tools: HarnessTool[];
  model?: string;
  maxBudgetUsd?: number;
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
export type ErrorKind = 'rate_limit' | 'billing' | 'auth' | 'sandbox' | 'hardening' | 'other';

/** The normalized stream every adapter produces (agent-adapters.md §3). Paths are relative to the worktree. */
export type Observation =
  | { kind: 'process.started'; pid: number }
  | { kind: 'session.init'; vendorSessionId: string; vendorVersion: string; model: string }
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'turn.started' }
  | { kind: 'turn.ended'; reason: string; isError: boolean }
  | { kind: 'tool.called'; tool: string; category: ToolCategory; paths?: string[]; command?: string }
  | { kind: 'edit.observed'; paths: string[]; outside: string[] }
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number; cumulative: true }
  | { kind: 'error'; error: ErrorKind; message: string }
  | { kind: 'delivery'; messageId: string; landed: Landed; deliveredAt: number }
  | { kind: 'ended'; reason: string };

/**
 * Where an adapter's hooks report to. `gate` runs before every tool call and returns a reason to
 * deny it, or null; the adapter uses it to hold tools until the session's hardening is verified.
 */
export type HarnessHookSink = { observe: (o: Observation) => void; gate?: () => Promise<string | null> };

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
  stopSession(h: SessionHandle, mode: 'graceful' | 'kill'): Promise<void>;
  getStatus(h: SessionHandle): SessionStatus;
  /** Pure: the vendor's permission and sandbox config for this session. */
  compilePermissions(spec: SessionSpec): PolicyBundle;
  setupHooks(spec: SessionSpec, sink: HarnessHookSink): HookBundle;
  observations(h: SessionHandle): AsyncIterable<Observation>;
}
