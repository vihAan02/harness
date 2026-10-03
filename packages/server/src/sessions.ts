// Agent sessions (protocol.md §3, §4; D-54). harnessd reports each session it runs, for the agent
// (`as_agent`), from its device connection. The first report creates the session; later ones change its
// status, record the vendor's ids on the row (protocol.md §10), and report usage. These events are the "which agents are alive"
// part of the 0A exit criteria, and usage.reported feeds A/B metric M8.
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';

const STATUSES = ['starting', 'working', 'idle', 'waiting', 'suspended', 'errored', 'ended'];
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USAGE_KEYS = ['input', 'output', 'cache_read', 'cache_creation', 'cost_usd'] as const;

const short = (v: unknown, name: string, max: number): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v || v.length > max) throw new CommandError('bad_request', `${name} is malformed`);
  return v;
};

/** harnessd reporting for one of its human's agents, from that human's device. */
export function requireAgentOnDevice(ctx: HandlerContext): { agentId: string; deviceId: string } {
  if (!ctx.caller.deviceId) throw new CommandError('forbidden', 'only harnessd reports agent activity');
  if (!ctx.actor.onBehalfOf) throw new CommandError('bad_request', 'send this as the agent (as_agent)');
  return { agentId: ctx.actor.principal, deviceId: ctx.caller.deviceId };
}

/** `session.report { session_id, status, task_id?, worktree?, branch?, vendor_session_id?, vendor_version?, usage?, reason? }` */
export async function reportSession(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const { agentId, deviceId } = requireAgentOnDevice(ctx);
  const sessionId = args.session_id;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new CommandError('bad_request', 'session_id must be a UUID');
  const status = args.status;
  if (typeof status !== 'string' || !STATUSES.includes(status)) throw new CommandError('bad_request', `status must be one of ${STATUSES.join(', ')}`);
  const vendorSessionId = short(args.vendor_session_id, 'vendor_session_id', 200);
  const vendorVersion = short(args.vendor_version, 'vendor_version', 100);
  const reason = short(args.reason, 'reason', 300);
  let tools: { tool_calls: Record<string, number>; denied_calls: number } | undefined;
  if (args.tools !== undefined) {
    const t = args.tools as { calls?: unknown; denied?: unknown };
    const calls = t?.calls as Record<string, unknown> | undefined;
    const ok = typeof calls === 'object' && calls !== null && Object.keys(calls).length <= 100
      && Object.entries(calls).every(([k, v]) => /^[A-Za-z0-9_.:-]{1,100}$/.test(k) && Number.isSafeInteger(v) && (v as number) >= 0)
      && Number.isSafeInteger(t.denied) && (t.denied as number) >= 0;
    if (!ok) throw new CommandError('bad_request', 'tools must be { calls: { <tool>: count }, denied: count }');
    tools = { tool_calls: calls as Record<string, number>, denied_calls: t.denied as number };
  }
  let usage: Record<string, number> | undefined;
  if (args.usage !== undefined) {
    const u = args.usage as Record<string, unknown>;
    if (typeof u !== 'object' || u === null || !USAGE_KEYS.every((k) => typeof u[k] === 'number' && Number.isFinite(u[k]) && (u[k] as number) >= 0)) {
      throw new CommandError('bad_request', `usage needs ${USAGE_KEYS.join(', ')} as non-negative numbers`);
    }
    usage = Object.fromEntries(USAGE_KEYS.map((k) => [k, u[k] as number]));
  }

  const events: HandlerOutput['events'] = [];
  const row = (await ctx.tx.query<{ agent_id: string; device_id: string; task_id: string; status: string }>(
    `SELECT s.agent_id, s.device_id, s.task_id, s.status FROM agent_sessions s JOIN tasks t ON t.id = s.task_id
     WHERE s.id = $1 AND t.project_id = $2 FOR UPDATE OF s`, [sessionId, ctx.projectId])).rows[0];
  let taskId: string;
  if (!row) {
    taskId = typeof args.task_id === 'string' && TASK_ID.test(args.task_id) ? args.task_id : '';
    if (!taskId) throw new CommandError('bad_request', 'a new session needs task_id');
    const worktree = short(args.worktree, 'worktree', 1024);
    const branch = short(args.branch, 'branch', 255);
    if (!worktree?.startsWith('/') || !branch) throw new CommandError('bad_request', 'a new session needs an absolute worktree and a branch');
    const task = (await ctx.tx.query<{ assignee_agent_id: string | null }>(
      'SELECT assignee_agent_id FROM tasks WHERE id = $1 AND project_id = $2', [taskId, ctx.projectId])).rows[0];
    if (!task) throw new CommandError('not_found', `no task ${taskId} in this project`);
    if (task.assignee_agent_id && task.assignee_agent_id !== agentId) throw new CommandError('forbidden', `${taskId} is assigned to another agent`);
    if (status === 'ended') throw new CommandError('bad_request', 'a session cannot start ended');
    await ctx.tx.query(
      `INSERT INTO agent_sessions (id, agent_id, device_id, task_id, worktree_path, branch, vendor_session_id, vendor_version, status, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [sessionId, agentId, deviceId, taskId, worktree, branch, vendorSessionId ?? null, vendorVersion ?? null, status]);
    events.push({ kind: 'session.started', data: { session_id: sessionId, agent_id: agentId, task_id: taskId, device_id: deviceId, worktree, branch, status } });
  } else {
    if (row.agent_id !== agentId || row.device_id !== deviceId) throw new CommandError('forbidden', 'that session belongs to another agent or device');
    if (row.status === 'ended') throw new CommandError('conflict', `session ${sessionId} has ended`);
    taskId = row.task_id;
    await ctx.tx.query(
      `UPDATE agent_sessions SET status = $2, last_heartbeat_at = now(),
         vendor_session_id = coalesce($3, vendor_session_id), vendor_version = coalesce($4, vendor_version),
         ended_at = CASE WHEN $2 = 'ended' THEN now() ELSE ended_at END
       WHERE id = $1`, [sessionId, status, vendorSessionId ?? null, vendorVersion ?? null]);
    if (status === 'ended') events.push({ kind: 'session.ended', data: { session_id: sessionId, agent_id: agentId, task_id: taskId, ...(reason ? { reason } : {}) } });
    else if (status !== row.status) events.push({ kind: 'session.status', data: { session_id: sessionId, agent_id: agentId, task_id: taskId, status, previous: row.status, ...(reason ? { reason } : {}) } });
  }
  // Usage and tool counts are the session's running totals (A/B metrics M8, M5b, H-07).
  if (usage || tools) events.push({ kind: 'usage.reported', data: { session_id: sessionId, agent_id: agentId, task_id: taskId, cumulative: true, ...usage, ...tools } });
  return { result: { session_id: sessionId }, events };
}
