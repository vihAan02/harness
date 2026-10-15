// Reports from harnessd about things that happen on its machine (protocol.md §4). They change no
// server state; they put facts in the event log, so the human and the A/B metrics can see them.
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { requireAgentOnDevice } from './sessions.ts';

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function requireTask(ctx: HandlerContext, taskId: unknown): Promise<string> {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new CommandError('bad_request', 'task_id is missing or malformed');
  const found = await ctx.tx.query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [taskId, ctx.projectId]);
  if (!found.rowCount) throw new CommandError('not_found', `no task ${taskId} in this project`);
  return taskId;
}
function requireDevice(ctx: HandlerContext): string {
  if (!ctx.caller.deviceId || ctx.actor.onBehalfOf) throw new CommandError('forbidden', 'only harnessd reports what happens on its device');
  return ctx.caller.deviceId;
}

/**
 * `worktree.report { task_id, event: created | committed | removed, path, branch?, commit? }` →
 * `worktree.created` / `worktree.committed` / `worktree.removed`. `committed` is harnessd's commit of a
 * finished task's work (D-50, D-54), so the human knows which commit to review.
 */
export async function reportWorktree(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const deviceId = requireDevice(ctx);
  const taskId = await requireTask(ctx, args.task_id);
  const { event, path, branch, commit, base_sha: baseSha } = args;
  if (event !== 'created' && event !== 'committed' && event !== 'removed') throw new CommandError('bad_request', 'event must be created, committed or removed');
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024) throw new CommandError('bad_request', 'path must be absolute');
  if (branch !== undefined && (typeof branch !== 'string' || branch.length > 255)) throw new CommandError('bad_request', 'branch is malformed');
  if (commit !== undefined && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))) throw new CommandError('bad_request', 'commit must be a full SHA');
  if (baseSha !== undefined && (event !== 'created' || typeof baseSha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha))) throw new CommandError('bad_request', 'base_sha is a full commit id, on created only');
  // The base a new worktree starts from: reads are checked against lands completed after it (0011).
  if (event === 'created' && baseSha) await ctx.tx.query('UPDATE tasks SET base_sha = $2, base_set_at = now() WHERE id = $1', [taskId, baseSha]);
  return {
    result: null,
    events: [{ kind: `worktree.${event}`, data: { task_id: taskId, device_id: deviceId, path, ...(branch ? { branch } : {}), ...(commit ? { commit } : {}) } }],
  };
}

/**
 * `setup.report { task_id, command_hash, event, exit_code? }` → `setup.<event>` (D-52). The approval itself
 * happens at harnessd's local prompt; this only records it.
 */
export async function reportSetup(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const deviceId = requireDevice(ctx);
  const taskId = await requireTask(ctx, args.task_id);
  const { command_hash: hash, event, exit_code: exitCode } = args;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new CommandError('bad_request', 'command_hash must be a sha256 hex digest');
  if (!['approval_requested', 'approved', 'ran', 'failed'].includes(event as string)) {
    throw new CommandError('bad_request', 'event must be approval_requested, approved, ran or failed');
  }
  if (exitCode !== undefined && !Number.isSafeInteger(exitCode)) throw new CommandError('bad_request', 'exit_code must be an integer');
  return {
    result: null,
    events: [{ kind: `setup.${event}`, data: { task_id: taskId, device_id: deviceId, command_hash: hash, ...(exitCode !== undefined ? { exit_code: exitCode } : {}) } }],
  };
}

const SHA = /^[0-9a-f]{40}$/;
const DELEGATED = ['publish', 'integrate', 'refresh'];

/**
 * `delegation.report { task_id, action, head_sha, base_sha, pr_number?, land_id?, policy_sha256 }` → `delegation.acted`
 * (D-145). harnessd made a routine decision for its human without a click: approved a publish, signed an integrate, or
 * brought a PR up to date. Only for a task whose agent is the reporting human's own, so the log says whose policy acted.
 */
export async function reportDelegation(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const deviceId = requireDevice(ctx);
  const taskId = await requireTask(ctx, args.task_id);
  const { action, head_sha: head, base_sha: base, pr_number: pr, land_id: land, policy_sha256: policy } = args;
  if (typeof action !== 'string' || !DELEGATED.includes(action)) throw new CommandError('bad_request', `action must be one of ${DELEGATED.join(', ')}`);
  if (typeof head !== 'string' || !SHA.test(head) || typeof base !== 'string' || !SHA.test(base)) throw new CommandError('bad_request', 'head_sha and base_sha must be full commit ids');
  if (pr !== undefined && (!Number.isSafeInteger(pr) || (pr as number) < 1)) throw new CommandError('bad_request', 'pr_number must be a PR number');
  if (land !== undefined && (typeof land !== 'string' || !/^land_[A-Za-z0-9]{1,40}$/.test(land))) throw new CommandError('bad_request', 'land_id is malformed');
  if (typeof policy !== 'string' || !/^[0-9a-f]{64}$/.test(policy)) throw new CommandError('bad_request', 'policy_sha256 must be a sha256 hex digest');
  const human = (await ctx.tx.query<{ h: string }>(
    'SELECT a.accountable_human_id AS h FROM tasks t JOIN agent_principals a ON a.id = t.assignee_agent_id WHERE t.id = $1 AND t.project_id = $2',
    [taskId, ctx.projectId])).rows[0]?.h;
  if (human !== ctx.caller.principal) throw new CommandError('forbidden', `${taskId}'s agent isn't yours: only its own human's policy acts for it`);
  return {
    result: null,
    events: [{ kind: 'delegation.acted', data: {
      task_id: taskId, device_id: deviceId, action, head_sha: head, base_sha: base, policy_sha256: policy,
      ...(pr !== undefined ? { pr_number: pr } : {}), ...(land !== undefined ? { land_id: land } : {}),
    } }],
  };
}

/**
 * `stop_gate.report { session_id, pending }` → `stop_gate.capped` (D-100). The agent's Stop gate kept it going
 * as many times in a row as its vendor allows, with `pending` notices still waiting; they open its next turn.
 * The event is how the human hears about it. Sent as the agent, from its device.
 */
export async function reportStopGate(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const { agentId, deviceId } = requireAgentOnDevice(ctx);
  if (!Number.isSafeInteger(args.pending) || (args.pending as number) < 1 || (args.pending as number) > 10_000) throw new CommandError('bad_request', 'pending must be a whole number from 1 to 10000');
  const sess = (await ctx.tx.query<{ task_id: string; agent_id: string; device_id: string }>(
    'SELECT s.task_id, s.agent_id, s.device_id FROM agent_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = $1 AND t.project_id = $2',
    [args.session_id, ctx.projectId])).rows[0];
  if (!sess) throw new CommandError('not_found', `no session ${String(args.session_id)} in this project`);
  if (sess.agent_id !== agentId || sess.device_id !== deviceId) throw new CommandError('forbidden', 'that session belongs to another agent or device');
  return {
    result: null,
    events: [{ kind: 'stop_gate.capped', data: { task_id: sess.task_id, agent_id: agentId, session_id: args.session_id, pending: args.pending } }],
  };
}
