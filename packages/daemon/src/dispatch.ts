// Signed dispatch on the target device (D-112; docs/protocol.md §11). The server checked a lifecycle command's
// dispatch against its device registry; harnessd checks it again before it acts, against what it holds itself:
// - the issuer's key and human, from this device's own pins (`[trust.devices]`), never from the server;
// - the coordinator's epoch, this device as the target, and the task (title, text, scope, owner) and message as
//   its own view has them;
// - the expiry, and the nonce: a dispatch acts once. The same event delivered again (a restart before the cursor
//   moved) is the same nonce at the same seq; a nonce seen at another seq is a replay.
// A start, reopen or resume issued by another human then waits for a single-use local approval bound to the
// nonce and the hashes (D-34). The envelope can't carry local policy (T-5b): signing.ts refuses it outright.
import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { DispatchEnvelope, DispatchKind, DispatchRejectReason, SignedDispatch } from '@harness/protocol';
import {
  DISPATCH_LIFETIME_MS, canonicalJson, expectDispatch, isNonce, messageSha256, newNonce, signDispatch, taskSha256, verifyDispatch,
} from '@harness/protocol/signing';
import type { TrustedDeviceConfig } from './config.ts';

/** The dispatch each lifecycle event carries. The agent's own `report_done` (`task.completed` by the agent) carries none. */
export const DISPATCH_OF: Record<string, DispatchKind> = {
  'task.assigned': 'start', 'task.reopened': 'reopen', 'task.resumed': 'resume', 'task.completed': 'complete', 'task.abandoned': 'abandon',
};
/** The kinds that start a session: from another human, they wait for this human's approval (D-34). */
export const STARTS: readonly DispatchKind[] = ['start', 'reopen', 'resume'];

export type DispatchTask = { id: string; title: string; text: string; scope: string[]; ownerHumanId: string };
export type DispatchCheck = {
  trusted: Record<string, TrustedDeviceConfig>;
  deviceId: string;
  epoch: string | null;
  now: Date;
  projectId: string;
  task: DispatchTask;
  agentId: string;
  /** The reopen's or resume's text, as the event carries it. */
  message?: string;
  /** Where this nonce acted before, from the task's journal: the seq of that event, or null if never. */
  usedAt: (nonce: string) => number | null;
  /** The seq of the event being checked (a recovery re-checks the journaled receipt, at its seq). */
  seq: number;
};
export type Verdict =
  | { ok: true; envelope: DispatchEnvelope }
  | { ok: false; reason: DispatchRejectReason; detail: string; nonce?: string; kind?: DispatchKind };

/** What a refusal can name about a dispatch it couldn't trust: its nonce and kind, only if well formed. */
function named(input: unknown): { nonce?: string; kind?: DispatchKind } {
  const env = typeof input === 'object' && input !== null ? (input as { envelope?: Record<string, unknown> }).envelope : undefined;
  if (typeof env !== 'object' || env === null) return {};
  const kind = env.kind;
  return {
    ...(isNonce(env.nonce) ? { nonce: env.nonce } : {}),
    ...(typeof kind === 'string' && (Object.values(DISPATCH_OF) as string[]).concat('integrate').includes(kind) ? { kind: kind as DispatchKind } : {}),
  };
}

/** The target device's check of one dispatch (see the top of this file). */
export function checkDispatch(input: unknown, kind: DispatchKind, c: DispatchCheck): Verdict {
  const no = (reason: DispatchRejectReason, detail: string): Verdict => ({ ok: false, reason, detail, ...named(input) });
  const v = verifyDispatch(input, (id) => {
    const d = c.trusted[id];
    return d ? { humanId: d.humanId, key: d.key } : null;
  }, c.now);
  if (!v.ok) return no(v.reason, v.detail);
  const env = v.envelope;
  if (c.epoch === null) return no('wrong_epoch', 'this device has no coordinator epoch yet');
  const mismatch = expectDispatch(env, {
    kind, project_id: c.projectId, task_id: c.task.id, agent_id: c.agentId, target_device_id: c.deviceId, epoch: c.epoch,
    task_sha256: taskSha256({ title: c.task.title, text: c.task.text, scope: c.task.scope, owner_human_id: c.task.ownerHumanId }),
    ...(c.message === undefined ? {} : { message_sha256: messageSha256(c.message) }),
  });
  if (mismatch) return no(mismatch.reason, mismatch.detail);
  if (c.message === undefined && env.message_sha256 !== undefined) return no('content_mismatch', 'the dispatch covers a message the event does not carry');
  const at = c.usedAt(env.nonce);
  if (at !== null && at !== c.seq) return no('replayed', `nonce ${env.nonce} already acted at event ${at}`);
  return { ok: true, envelope: env };
}

/** The single-use local approval of a remote start, reopen or resume: bound to its nonce and what it starts (D-34). */
export function sessionApprovalHash(env: DispatchEnvelope): string {
  return createHash('sha256').update(canonicalJson({
    v: 1, approval: 'agent_session', nonce: env.nonce, kind: env.kind, project_id: env.project_id, task_id: env.task_id,
    agent_id: env.agent_id, issuer_human_id: env.issuer_human_id, task_sha256: env.task_sha256, message_sha256: env.message_sha256,
  })).digest('hex');
}

/** A dispatch this device issues (the UI's `dispatch`, the CLI through harnessd): signed with the device key, which never leaves harnessd. */
export function makeDispatch(key: KeyObject, f: {
  kind: DispatchKind; projectId: string; taskId: string; agentId: string; targetDeviceId: string;
  issuerHumanId: string; issuerDeviceId: string; epoch: string; task: DispatchTask; message?: string;
  integrate?: NonNullable<DispatchEnvelope['integrate']>; now?: Date; lifetimeMs?: number;
}): SignedDispatch {
  const now = f.now ?? new Date();
  const life = Math.min(f.lifetimeMs ?? DISPATCH_LIFETIME_MS[f.kind], DISPATCH_LIFETIME_MS[f.kind]);
  return signDispatch(key, {
    v: 1, kind: f.kind, project_id: f.projectId, task_id: f.taskId, agent_id: f.agentId, target_device_id: f.targetDeviceId,
    issuer_human_id: f.issuerHumanId, issuer_device_id: f.issuerDeviceId, epoch: f.epoch, nonce: newNonce(),
    issued_at: now.toISOString(), expires_at: new Date(now.getTime() + life).toISOString(),
    task_sha256: taskSha256({ title: f.task.title, text: f.task.text, scope: f.task.scope, owner_human_id: f.task.ownerHumanId }),
    ...(f.message === undefined ? {} : { message_sha256: messageSha256(f.message) }),
    ...(f.integrate ? { integrate: f.integrate } : {}),
  });
}

/** Why a dispatched start, reopen or resume ended before a session began (`task.start_failed`, D-113). */
export type StartFailedReason = 'aborted' | 'approval_expired' | 'approval_denied' | 'setup_failed' | 'capacity' | 'no_adapter' | 'budget' | 'error';
/** A start refused on this device for a reason the server is told (`task.start_failed`), which frees the agent there. */
export class StartRefused extends Error {
  reason: StartFailedReason;
  constructor(reason: StartFailedReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
