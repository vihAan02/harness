// Hard claims: lease commands (0B item 5; D-20, D-21, D-89; contract D-97, protocol.md §3/§4).
// Stream B builds the handlers here (D-94). Until then they refuse, and the land step's fencing check
// (lands.ts) already honours any lease that exists.
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';

/**
 * The project's lease lock (D-97). Every command that grants, renews, releases or revokes leases takes it
 * first, before any row lock (`land.complete` takes it right after the invalidation lock), so first come,
 * first served holds even when no lease rows exist yet, and lease writers share one lock order.
 */
export async function lockLeases(ctx: HandlerContext): Promise<void> {
  await ctx.tx.query("SELECT pg_advisory_xact_lock(hashtext('harness.leases:' || $1))", [ctx.projectId]);
}

const notYet = (name: string) => async (): Promise<HandlerOutput> => {
  throw new CommandError('bad_request', `${name} is not available yet (0B item 5)`);
};

/** `lease.acquire { task_id, paths[], ttl_s?, force? }` → `{ granted[], conflicts[] }` (D-97). */
export const acquireLease = notYet('lease.acquire');
/** `lease.renew { lease_ids[], ttl_s? }` → `{ renewed[], lost[] }`, from harnessd only (D-97). */
export const renewLeases = notYet('lease.renew');
/** `lease.release { lease_ids[] }` → `{ released[] }` (D-97). */
export const releaseLeases = notYet('lease.release');
