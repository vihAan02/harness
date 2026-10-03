// The internal coordination protocol (D-14): what harnessd, the CLI and the server speak.
// docs/protocol.md is canonical for event, command, tool and message-kind names.
// Transport: JSON over one WebSocket per client; every message carries `v` and `type` (protocol.md §1).

/** Carried as `v` on every message (protocol.md §1, §10). */
export const PROTOCOL_VERSION = 1;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type ClientKind = 'harnessd' | 'cli' | 'dashboard';
/** Resume point: the client has processed every event up to and including `after_seq`. */
export type Subscription = { project_id: string; after_seq: number };

// ---------- client → server ----------

/** Must be the first message on a connection. Phase 0 auth is a local token (protocol.md §2). */
export type Hello = {
  v: ProtocolVersion; type: 'hello';
  client: { kind: ClientKind; version: string };
  principal: string; // the human this client acts for
  device_id?: string; // harnessd only
  auth: { scheme: 'local-token'; token: string };
  subscribe?: Subscription[];
};
export type Subscribe = { v: ProtocolVersion; type: 'subscribe'; subscribe: Subscription[] };
/**
 * Idempotent: the server de-duplicates on `command_id`, so a retry after a disconnect is safe.
 * `as_agent` sends it for an agent principal accountable to this connection's human (D-18).
 */
export type Command = {
  v: ProtocolVersion; type: 'command';
  command_id: string; project_id: string; name: string; args: Record<string, unknown>;
  as_agent?: string;
};
/** harnessd only, every few seconds. Keeps the device's presence; logs an event only when presence changes (D-75). */
export type Heartbeat = { v: ProtocolVersion; type: 'heartbeat' };
export type ClientMessage = Hello | Subscribe | Command | Heartbeat;

// ---------- server → client ----------

export type ProjectHead = { project_id: string; head_seq: number };
export type Welcome = { v: ProtocolVersion; type: 'welcome'; server_time: string; projects: ProjectHead[] };
export type Subscribed = { v: ProtocolVersion; type: 'subscribed'; projects: ProjectHead[] };
/** At-least-once: consumers must be idempotent on (project_id, seq) (protocol.md §3). */
export type EventMessage = {
  v: ProtocolVersion; type: 'event';
  project_id: string; seq: number; at: string;
  actor: { principal: string; on_behalf_of: string | null; device_id: string | null };
  kind: string; data: unknown;
};
export type ErrorCode = 'bad_request' | 'unsupported_version' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'internal';
export type CommandResult =
  | { v: ProtocolVersion; type: 'command_result'; command_id: string; ok: true; seqs: number[]; result: unknown; duplicate: boolean }
  | { v: ProtocolVersion; type: 'command_result'; command_id: string; ok: false; error: { code: ErrorCode; message: string } };
/** A connection-level error. After `unauthorized` or `unsupported_version`, the server closes the socket. */
export type ErrorMessage = { v: ProtocolVersion; type: 'error'; code: ErrorCode; message: string };
export type ServerMessage = Welcome | Subscribed | EventMessage | CommandResult | ErrorMessage;
