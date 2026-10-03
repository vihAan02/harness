// Reports from harnessd about things that happen on its machine (protocol.md §4). They change no
// server state; they put facts in the event log, so the human and the A/B metrics can see them.
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';

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

/** `worktree.report { task_id, event: created | removed, path }` → `worktree.created` / `worktree.removed`. */
export async function reportWorktree(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const deviceId = requireDevice(ctx);
  const taskId = await requireTask(ctx, args.task_id);
  const { event, path, branch } = args;
  if (event !== 'created' && event !== 'removed') throw new CommandError('bad_request', 'event must be created or removed');
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024) throw new CommandError('bad_request', 'path must be absolute');
  if (branch !== undefined && (typeof branch !== 'string' || branch.length > 255)) throw new CommandError('bad_request', 'branch is malformed');
  return { result: null, events: [{ kind: `worktree.${event}`, data: { task_id: taskId, device_id: deviceId, path, ...(branch ? { branch } : {}) } }] };
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
