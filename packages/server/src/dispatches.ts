// Signed dispatch, the server's half (D-112; docs/protocol.md §11). A command that starts, resumes, reopens,
// abandons or completes an agent's task carries a dispatch signed by the issuing device. The server checks it
// against the issuer's registered key and the connection, against the task and agent as stored, and keeps its
// nonce once. The target harnessd checks it again against its own pins before it acts (PA3). Local-token stacks
// that send no dispatch keep 0B's behaviour.
import type { DispatchKind, SignedDispatch } from '@harness/protocol';
import { expectDispatch, messageSha256, taskSha256, verifyDispatch } from '@harness/protocol/signing';
import { isUniqueViolation } from './db.ts';
import { CommandError, type HandlerContext } from './handler.ts';

export type DispatchTask = { id: string; title: string; text: string; scope: string[]; owner_human_id: string };
export type DispatchAgent = { id: string; accountable_human_id: string; device_id: string | null };
/** What a lifecycle event echoes: the dispatch it was sent with, and the one device that may act on it (D-113). */
export type Routed = { dispatch?: SignedDispatch; target_device_id?: string };

export async function loadAgent(ctx: HandlerContext, agentId: string): Promise<DispatchAgent> {
  const agent = (await ctx.tx.query<DispatchAgent>(
    'SELECT id, accountable_human_id, device_id FROM agent_principals WHERE id = $1 AND project_id = $2', [agentId, ctx.projectId])).rows[0];
  if (!agent) throw new CommandError('not_found', `no agent ${agentId} in this project`);
  return agent;
}

/** A dispatch is required on a device-key connection, and in a GitHub-mode project whoever connects (D-112). */
export async function dispatchRequired(ctx: HandlerContext): Promise<boolean> {
  if (ctx.caller.authDeviceId) return true;
  const mode = (await ctx.tx.query<{ integration_mode: string }>('SELECT integration_mode FROM projects WHERE id = $1', [ctx.projectId])).rows[0]?.integration_mode;
  return mode === 'github';
}

function refuse(reason: string, detail: string): never {
  throw new CommandError(reason === 'replayed' ? 'conflict' : 'forbidden', `dispatch refused (${reason}): ${detail}`);
}

/**
 * Checks a lifecycle command's `args.dispatch` and stores its nonce, once. Returns what its event echoes: the
 * dispatch and the agent's device, or only the device for a local-token command that needs no dispatch.
 * `message` is the reopen's or resume's text as stored, which `message_sha256` covers.
 */
export async function checkDispatch(ctx: HandlerContext, input: unknown, expected: {
  kind: DispatchKind; task: DispatchTask; agent: DispatchAgent; message?: string;
}): Promise<Routed> {
  const { task, agent } = expected;
  const routed: Routed = agent.device_id ? { target_device_id: agent.device_id } : {};
  if (input === undefined && !(await dispatchRequired(ctx))) return routed;
  const issuerId = typeof input === 'object' && input !== null ? (input as { envelope?: { issuer_device_id?: unknown } }).envelope?.issuer_device_id : undefined;
  const issuer = typeof issuerId !== 'string' ? undefined : (await ctx.tx.query<{ human_id: string; public_key: string }>(
    'SELECT human_id, public_key FROM devices WHERE id = $1 AND revoked_at IS NULL AND public_key IS NOT NULL', [issuerId])).rows[0];
  const now = (await ctx.tx.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
  const verdict = verifyDispatch(input, (id) => (issuer && id === issuerId ? { humanId: issuer.human_id, key: issuer.public_key } : null), now);
  if (!verdict.ok) refuse(verdict.reason, verdict.detail);
  const env = verdict.envelope;
  // The issuer is this connection's own device and human: a dispatch can't be relayed by someone else.
  if (env.issuer_device_id !== ctx.caller.authDeviceId || env.issuer_human_id !== ctx.caller.principal) {
    refuse('issuer_mismatch', `issued by ${env.issuer_device_id} for ${env.issuer_human_id}, sent by ${ctx.caller.authDeviceId ?? 'a connection without a device key'} for ${ctx.caller.principal}`);
  }
  if (!agent.device_id) refuse('wrong_target', `${agent.id} isn't bound to a device; create the agent on its device`);
  const epoch = (await ctx.tx.query<{ epoch: string }>('SELECT epoch FROM coordinator_epoch')).rows[0]?.epoch;
  const mismatch = expectDispatch(env, {
    kind: expected.kind, project_id: ctx.projectId, task_id: task.id, agent_id: agent.id, target_device_id: agent.device_id, epoch,
    task_sha256: taskSha256(task), ...(expected.message === undefined ? {} : { message_sha256: messageSha256(expected.message) }),
  });
  if (mismatch) refuse(mismatch.reason, mismatch.detail);
  if (expected.message === undefined && env.message_sha256 !== undefined) refuse('content_mismatch', 'the dispatch covers a message this command does not carry');
  try {
    await ctx.tx.query(
      `INSERT INTO dispatches (nonce, project_id, task_id, kind, issuer_device_id, issuer_human_id, target_device_id, envelope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [env.nonce, ctx.projectId, task.id, env.kind, env.issuer_device_id, env.issuer_human_id, env.target_device_id, JSON.stringify(env)]);
  } catch (e) {
    if (isUniqueViolation(e, 'dispatches_pkey')) refuse('replayed', `nonce ${env.nonce} was already used`);
    throw e;
  }
  return { dispatch: { envelope: env, sig: (input as SignedDispatch).sig }, target_device_id: env.target_device_id };
}
