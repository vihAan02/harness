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

/**
 * Must be the first message on a connection (protocol.md §2).
 * - `local-token`: Phase 0, loopback test and demo stacks only (D-74).
 * - `device-key`: the pilot (D-111). The server answers with a `challenge`; the client checks the server's
 *   signature against its pinned server key, then sends `auth`. Every client kind names its device.
 */
export type Hello = {
  v: ProtocolVersion; type: 'hello';
  client: { kind: ClientKind; version: string };
  principal: string; // the human this client acts for
  device_id?: string; // harnessd only with local-token; every client with device-key
  auth: { scheme: 'local-token'; token: string } | { scheme: 'device-key'; client_nonce: string };
  subscribe?: Subscription[];
};
/** device-key only: the client's signature over the HelloDeviceProof (signing.ts), after it has checked the challenge. */
export type Auth = { v: ProtocolVersion; type: 'auth'; sig: string };
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
export type ClientMessage = Hello | Auth | Subscribe | Command | Heartbeat;

// ---------- server → client ----------

/** `integration_mode` is set on the server per project (D-114); absent from a server that predates it, meaning `local`. */
export type ProjectHead = { project_id: string; head_seq: number; integration_mode?: IntegrationMode };
/** device-key only: the server's nonce and its signature over the HelloServerProof (signing.ts). Nothing else comes before the client checks it. */
export type Challenge = { v: ProtocolVersion; type: 'challenge'; server_nonce: string; server_key_id: string; sig: string };
/** `epoch` names the coordinator's database (D-113): a different one means a new coordinator. Absent before migration 0014. */
export type Welcome = { v: ProtocolVersion; type: 'welcome'; server_time: string; projects: ProjectHead[]; epoch?: string };
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
export type ServerMessage = Challenge | Welcome | Subscribed | EventMessage | CommandResult | ErrorMessage;
/** WebSocket close code: a newer harnessd connection for the same device replaced this one (D-113). Fatal only on a verified connection (D-111). */
export const CLOSE_DEVICE_REPLACED = 4001;

// ---------- the two-Mac pilot (D-110 to D-119; protocol.md §11 and §12) ----------

export type IntegrationMode = 'local' | 'github';

/** Signed by the issuing device (D-112). Built and checked with signing.ts; carried as `args.dispatch`, echoed as `event.data.dispatch`. */
export type DispatchKind = 'start' | 'resume' | 'reopen' | 'abandon' | 'complete' | 'integrate';
export type DispatchEnvelope = {
  v: 1; kind: DispatchKind;
  project_id: string; task_id: string; agent_id: string;
  /** The device that acts: the agent's for every kind but `integrate`, the approver's own for `integrate`. */
  target_device_id: string;
  issuer_human_id: string; issuer_device_id: string;
  epoch: string; nonce: string; issued_at: string; expires_at: string;
  /** signing.taskSha256 over the task's title, text, scope and owner, as the issuer saw them. */
  task_sha256: string;
  /** signing.messageSha256 of a reopen's (required) or resume's (optional) message. */
  message_sha256?: string;
  /** integrate only: what the human approved. */
  integrate?: { pr_number: number; head_sha: string; base_sha: string; paths_sha256: string };
};
export type SignedDispatch = { envelope: DispatchEnvelope; sig: string };
export type DispatchRejectReason =
  | 'missing' | 'malformed' | 'policy_widening' | 'unknown_issuer' | 'issuer_mismatch' | 'bad_signature' | 'lifetime' | 'not_yet_valid' | 'expired'
  | 'wrong_kind' | 'wrong_target' | 'wrong_epoch' | 'content_mismatch' | 'replayed' | 'approval_expired' | 'approval_denied';

/** `dispatch.rejected` (target harnessd → server): it refused a lifecycle event's dispatch; the server frees the agent (D-112). */
export type DispatchRejectedArgs = { task_id: string; nonce?: string; kind?: DispatchKind; reason: DispatchRejectReason; detail?: string };
/** `task.start_failed` (harnessd → server): a start, reopen or resume ended before a session began (D-113). */
export type TaskStartFailedArgs = { task_id: string; nonce: string; reason: 'aborted' | 'approval_expired' | 'approval_denied' | 'setup_failed' | 'capacity' | 'no_adapter' | 'budget' | 'error'; detail?: string };

/** Why a session ended, beyond the adapter's own reasons (D-113, D-116). */
export type SessionEndReason = 'harnessd_restarted' | 'start_interrupted' | 'start_failed' | 'provider_auth' | 'provider_billing' | 'budget' | 'rate_limited';

/** A PR's checks and reviews as harnessd last polled them (D-114). */
export type CheckConclusion = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'cancelled';
export type PrReview = { login: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; commit_id: string };
/** `pr.publish` (the task's harnessd): it pushed the task branch and opened (or found) the PR → `pr.published`. */
export type PrPublishArgs = { task_id: string; pr_number: number; url: string; head_sha: string; base_sha: string; remote_ref: string };
/** `pr.status` (the task's harnessd, when something changed) → `pr.updated`. */
export type PrStatusArgs = {
  task_id: string; pr_number: number; head_sha: string; state: 'open' | 'closed'; merged: boolean; merge_sha?: string;
  mergeable_state: string; checks: Record<string, CheckConclusion>; reviews: PrReview[];
};
/** `publish.blocked` (the task's harnessd): the pre-push gate refused; nothing was pushed (D-114). */
export type PublishBlockedArgs = { task_id: string; reasons: { commit?: string; path?: string; rule: string }[] };
/** A changed file and its blob at the new base (null: deleted), as `land.complete` already carries it. */
export type ChangedBlob = { path: string; new_hash: string | null };
/** `base.observe` (any harnessd that saw the remote base move): compare-and-swap on the project's base tip (D-114). */
export type BaseObserveArgs = { old_sha: string; new_sha: string; changed: ChangedBlob[] };
/** `land.external` (the task's harnessd): its PR was merged outside the harness (D-115's honest limit). */
export type LandExternalArgs = { task_id: string; pr_number: number; merge_sha: string; old_base_sha: string; changed: ChangedBlob[] };
/** `land.arm` (the reserving harnessd, synchronous, never from the outbox): sent before the merge request (D-115). */
export type LandArmArgs = { land_id: string; head_sha: string; base_sha: string };
/** `land.reconcile` (another member device, when the reserving one has been offline ≥ 10 minutes): GitHub's evidence (D-115). */
export type LandReconcileArgs = {
  land_id: string; pr_number: number; observed_head_sha: string; observed_base_sha: string; merged: boolean; merge_sha?: string; changed?: ChangedBlob[];
};
export type LandStep = 'merged' | 'setup' | 'awaiting_approval' | 'testing' | 'tested' | 'checking' | 'merge_requested' | 'outcome_unknown';
export type LandFailReason =
  | 'conflict' | 'tests' | 'not_approved' | 'base_moved' | 'base_checkout_dirty' | 'base_checkout_conflict' | 'interrupted' | 'error' | 'cancelled'
  | 'head_changed' | 'head_behind' | 'wrong_base' | 'checks_failed' | 'not_mergeable' | 'pr_closed' | 'review_required' | 'ci_busy'
  | 'protection_missing' | 'verification_failed' | 'dispatch_rejected';

/** The UI's and `harness status`'s derived state of a task (ProjectView.snapshot, D-117). */
export type DerivedTaskState =
  | 'open' | 'awaiting_approval' | 'starting' | 'running' | 'stopped' | 'blocked' | 'done' | 'publish_pending_approval' | 'publishing' | 'publish_blocked'
  | 'pr_open' | 'integrating' | 'outcome_unknown' | 'fetch_pending' | 'landed' | 'abandoned';

/**
 * One project as the UI renders it (D-117; protocol.md §12): `ProjectView.snapshot()` plus what only this device's
 * harnessd knows (its approvals, its publishing, its link). JSON-serializable. Every string that came from a task, an
 * agent, a peer, the server or GitHub is untrusted: the UI shows it as text only.
 */
export type ProjectSnapshot = {
  v: 1;
  project_id: string; head_seq: number; integration_mode: IntegrationMode; taken_at: string;
  /** This harnessd's device and human. */
  device_id: string; principal: string;
  connection: SnapshotConnection;
  tasks: TaskSnapshot[]; agents: AgentSnapshot[]; devices: { device_id: string; online: boolean; at: string }[];
  /** The latest 200, oldest first. */
  messages: MessageSnapshot[];
  waits: WaitSnapshot[]; lands: LandSnapshot[];
  /** Moves of the base made outside the harness (D-114), oldest first. */
  base_advances: { old_sha: string; new_sha: string; changed_paths: string[]; at: string }[];
  /** This device's spend on the UTC day (D-116). */
  budget: { day: string; spent_usd: number; daily_budget_usd: number | null; session_cap_usd: number | null };
};
export type SnapshotConnection = 'connecting' | 'connected' | 'server_identity_mismatch' | 'replaced' | 'refused' | 'coordinator_changed';
export type TaskSnapshot = {
  id: string; title: string; text: string; scope: string[]; owner_human_id: string; priority: number;
  assignee_agent_id: string | null;
  /** The server's status; `state` is what the UI shows. */
  status: string; state: DerivedTaskState;
  /** Why it's in that state, where there's a reason: a session's end, a land's failure, a sync's fetch error. Untrusted text. */
  state_detail: string | null;
  summary: string | null; created_at: string; assigned_at: string | null; completed_at: string | null;
  session: SessionSnapshot | null; pr: PrSnapshot | null; land: LandSnapshot | null;
  publish_blocked: { rule: string; path?: string; commit?: string }[] | null;
  /** Files its agent read that have changed since (D-91). */
  stale_reads: string[];
  leases: { path: string; expires_at: string }[];
  open_wait: WaitSnapshot | null;
  /** All its sessions, in USD at the configured prices. */
  cost_usd: number;
};
export type SessionSnapshot = {
  id: string; agent_id: string; device_id: string; status: string; started_at: string; ended_at: string | null; end_reason: string | null;
  model: string | null; cost_usd: number; input_tokens: number; output_tokens: number;
};
export type PrSnapshot = {
  number: number; url: string; head_sha: string; base_sha: string; state: 'open' | 'closed'; merged: boolean; merge_sha: string | null;
  mergeable_state: string | null; checks: Record<string, string>; reviews: { login: string; state: string; commit_id: string }[]; updated_at: string;
};
export type LandSnapshot = {
  id: string; task_id: string; mode: 'local' | 'github' | 'external'; status: 'requested' | 'accepted' | 'rejected' | 'completed' | 'failed';
  step: string | null; reason: string | null; detail: string | null; pr_number: number | null; new_base_sha: string | null;
  requested_at: string; finished_at: string | null;
};
export type AgentSnapshot = {
  id: string; name: string; vendor: string; human_id: string;
  /** The device of its latest session, and whether that device is online; null before its first session. */
  device_id: string | null; online: boolean | null;
  active_task_id: string | null; live_session_id: string | null;
};
export type MessageSnapshot = {
  id: string; kind: string; from: string; to: string | null; from_task: string | null; to_task: string | null; in_reply_to: string | null;
  text: string; priority: string; sent_at: string; seq: number;
};
export type WaitSnapshot = {
  id: string; task_id: string; session_id: string; on: { kind: string; id: string };
  outcome: 'waiting' | 'resolved' | 'timed_out' | 'cancelled'; started_at: string; timeout_at: string; finished_at: string | null; reason: string | null;
};
