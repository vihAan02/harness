// Sync reports (0B item 2; D-53; coordination.md §2). harnessd syncs a reader's task branch with the new base
// at its turn end, then reports the outcome, as the agent, before it delivers the held landed notice:
// - synced: the reader's entries for the files the sync brought in are stale until it reads them again;
// - conflict: the merge was aborted, the task is blocked and its agent paused; the human resolves the
//   conflict in the worktree and runs `harness task unblock` (agents don't run Git writes, D-50).
import { normalizeFilePath } from './claims.ts';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { newMessageId } from './messages.ts';
import { requireAgentOnDevice } from './sessions.ts';
import { lockTask } from './tasks.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_PATHS = 5000;

const sha = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !SHA.test(v)) throw new CommandError('bad_request', `${name} must be a full commit id`);
  return v;
};
const pathList = (v: unknown, name: string) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_PATHS) throw new CommandError('bad_request', `${name} must be a list of up to ${MAX_PATHS} paths`);
  return [...new Set(v.map(normalizeFilePath))].sort();
};

/** `sync.report { session_id, event: synced | conflict, old_base_sha, new_base_sha, changed_paths?, conflict_paths? }`. */
export async function reportSync(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const { agentId, deviceId } = requireAgentOnDevice(ctx);
  const sess = (await ctx.tx.query<{ task_id: string; agent_id: string; device_id: string }>(
    `SELECT s.task_id, s.agent_id, s.device_id FROM agent_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = $1 AND t.project_id = $2`,
    [args.session_id, ctx.projectId])).rows[0];
  if (!sess) throw new CommandError('not_found', `no session ${String(args.session_id)} in this project`);
  if (sess.agent_id !== agentId || sess.device_id !== deviceId) throw new CommandError('forbidden', 'that session belongs to another agent or device');
  const oldBase = sha(args.old_base_sha, 'old_base_sha');
  const newBase = sha(args.new_base_sha, 'new_base_sha');
  const task = await lockTask(ctx, sess.task_id);
  const base = { task_id: task.id, session_id: args.session_id, old_base_sha: oldBase, new_base_sha: newBase };

  if (args.event === 'synced') {
    const changed = pathList(args.changed_paths, 'changed_paths');
    const stale = (await ctx.tx.query<{ path: string }>(
      'UPDATE read_entries SET stale = true WHERE task_id = $1 AND path = ANY($2) AND NOT stale RETURNING path', [task.id, changed])).rows.map((r) => r.path).sort();
    return { result: { stale }, events: [{ kind: 'worktree.synced', data: { ...base, changed_paths: changed, stale_paths: stale } }] };
  }
  if (args.event !== 'conflict') throw new CommandError('bad_request', 'event must be synced or conflict');
  const conflicts = pathList(args.conflict_paths, 'conflict_paths');
  if (!conflicts.length) throw new CommandError('bad_request', 'a conflict report names the conflicting paths');
  if (task.status !== 'in_progress' && task.status !== 'blocked') throw new CommandError('conflict', `${task.id} is ${task.status}`);
  const events: HandlerOutput['events'] = [{ kind: 'worktree.sync_conflict', data: { ...base, paths: conflicts } }];
  if (task.status === 'in_progress') {
    await ctx.tx.query("UPDATE tasks SET status = 'blocked' WHERE id = $1", [task.id]);
    events.push({ kind: 'task.blocked', data: { task_id: task.id, reason: 'sync_conflict', paths: conflicts } });
    // The human resolves it (D-53): a task_blocked message to the task's owner, shown in status and the log.
    const id = newMessageId();
    const text = `${task.id} is blocked: syncing it with the new base conflicts in ${conflicts.join(', ')}. Its agent is paused. Resolve the conflict in its worktree (merge ${newBase.slice(0, 12)} and commit), then run: harness task unblock ${task.id}`;
    const data = { reason: 'sync_conflict', paths: conflicts, task: task.id, new_base_sha: newBase };
    await ctx.tx.query(
      `INSERT INTO messages (id, project_id, kind, from_principal, to_principal, text, data, priority, from_task_id, to_task_id)
       VALUES ($1, $2, 'task_blocked', 'harness', $3, $4, $5, 'high', NULL, $6)`,
      [id, ctx.projectId, task.owner_human_id, text, JSON.stringify(data), task.id]);
    events.push({ kind: 'message.sent', data: { message_id: id, kind: 'task_blocked', from: 'harness', to: task.owner_human_id, text, ...data, priority: 'high', from_task_id: null, to_task_id: task.id } });
  }
  return { result: null, events };
}

/** `task.unblock { task_id }` → `task.unblocked`. A human, after resolving the conflict; harnessd checks and resumes. */
export async function unblockTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  if (ctx.actor.onBehalfOf) throw new CommandError('forbidden', 'only a human can unblock a task');
  const task = await lockTask(ctx, args.task_id);
  if (task.status !== 'blocked') throw new CommandError('conflict', `${task.id} is ${task.status}, not blocked`);
  await ctx.tx.query("UPDATE tasks SET status = 'in_progress' WHERE id = $1", [task.id]);
  return { result: null, events: [{ kind: 'task.unblocked', data: { task_id: task.id, by: ctx.actor.principal } }] };
}
