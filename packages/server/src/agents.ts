import { randomUUID } from 'node:crypto';
import { isUniqueViolation } from './db.ts';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';

const VENDORS = ['claude', 'codex'];
const AGENT_NAME = /^agent\/[a-z0-9][a-z0-9._-]{0,62}$/;

/** `agent.create { name, vendor, device_id? }`: registers an agent principal accountable to the calling human (D-18, D-54). */
export async function createAgent(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  if (ctx.actor.onBehalfOf) throw new CommandError('forbidden', 'agents cannot create agents');
  const { name, vendor } = args;
  if (typeof name !== 'string' || !AGENT_NAME.test(name)) throw new CommandError('bad_request', 'name must look like agent/backend-1');
  if (typeof vendor !== 'string' || !VENDORS.includes(vendor)) throw new CommandError('bad_request', `vendor must be one of ${VENDORS.join(', ')}`);
  // The one device that runs the agent (D-113): with device keys, the caller's own unless it names another of its
  // human's devices. Local-token stacks leave it unset, and the agent runs wherever its human's harnessd is.
  let deviceId: string | null = null;
  if (args.device_id !== undefined || ctx.caller.authDeviceId) {
    const asked = args.device_id ?? ctx.caller.authDeviceId;
    if (typeof asked !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(asked)) throw new CommandError('bad_request', 'device_id is malformed');
    const own = await ctx.tx.query('SELECT 1 FROM devices WHERE id = $1 AND human_id = $2 AND revoked_at IS NULL', [asked, ctx.caller.principal]);
    if (!own.rowCount) throw new CommandError('forbidden', `${asked} isn't one of ${ctx.caller.principal}'s devices`);
    deviceId = asked;
  }
  const id = `agent_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  try {
    await ctx.tx.query(
      'INSERT INTO agent_principals (id, project_id, accountable_human_id, vendor, name, device_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, ctx.projectId, ctx.caller.principal, vendor, name, deviceId]);
  } catch (e) {
    if (isUniqueViolation(e, 'agent_principals_project_id_name_key')) throw new CommandError('conflict', `${name} already exists in this project`);
    throw e;
  }
  return {
    result: { agent_id: id },
    events: [{ kind: 'agent.created', data: { agent_id: id, name, vendor, accountable_human_id: ctx.caller.principal, ...(deviceId ? { device_id: deviceId } : {}) } }],
  };
}
