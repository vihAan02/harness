// Command execution (docs/protocol.md §1, §4). An accepted command runs in one transaction that
// records its state change, appends its events, stores its outcome under the client's command_id,
// and sends one payload-free wake-up. A retry, even one racing the original, gets the stored
// outcome back instead of running again.
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import type { Command } from '@harness/protocol';
import { inTransaction, isUniqueViolation } from './db.ts';
import { appendEvents, notifyProject } from './events.ts';
import { CommandError, type Actor, type Caller, type Handler } from './handler.ts';
import { createAgent } from './agents.ts';
import { reportSetup, reportStopGate, reportWorktree } from './reports.ts';
import { reportSession } from './sessions.ts';
import { abandonTask, reopenTask, assignTask, completeTask, createTask } from './tasks.ts';
import { ackMessage, sendMessage } from './messages.ts';
import { observeClaims } from './claims.ts';
import { addReadset } from './readsets.ts';
import { reportSync, unblockTask } from './syncs.ts';
import { armLand, cancelLand, completeLand, failLand, reportLand, requestLand, startLand } from './lands.ts';
import { acquireLease, releaseLeases, renewLeases } from './leases.ts';
import { startWait } from './waits.ts';
import { landExternal, observeBase, publishPr, reportPrStatus, reportPublishBlocked } from './integrations.ts';

export { CommandError, type Caller } from './handler.ts';
export { EVENTS_CHANNEL } from './events.ts';

/** Command names are canonical in docs/protocol.md §4. Each arrives with its roadmap item. */
const HANDLERS: Record<string, Handler> = {
  'agent.create': createAgent,
  'worktree.report': reportWorktree,
  'setup.report': reportSetup,
  'stop_gate.report': reportStopGate,
  'session.report': reportSession,
  'task.create': createTask,
  'task.assign': assignTask,
  'task.complete': completeTask,
  'task.abandon': abandonTask,
  'task.reopen': reopenTask,
  'message.send': sendMessage,
  'claim.observe': observeClaims,
  'message.ack': ackMessage,
  'readset.add': addReadset,
  'land.request': requestLand,
  land: startLand,
  'land.report': reportLand,
  'land.complete': completeLand,
  'land.fail': failLand,
  'land.cancel': cancelLand,
  'land.arm': armLand,
  'sync.report': reportSync,
  'task.unblock': unblockTask,
  'lease.acquire': acquireLease,
  'lease.renew': renewLeases,
  'lease.release': releaseLeases,
  'wait.start': startWait,
  // GitHub integration (D-114, D-115; protocol.md §11)
  'pr.publish': publishPr,
  'pr.status': reportPrStatus,
  'publish.blocked': reportPublishBlocked,
  'base.observe': observeBase,
  'land.external': landExternal,
};

export type CommandOutcome = { seqs: number[]; result: unknown; duplicate: boolean };

/** Postgres deadlock_detected and serialization_failure: the transaction did nothing, so it's safe to run again. */
const RETRYABLE = new Set(['40P01', '40001']);
const ATTEMPTS = 3;

export async function executeCommand(pool: pg.Pool, caller: Caller, cmd: Command): Promise<CommandOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await executeOnce(pool, caller, cmd);
    } catch (e) {
      if (attempt >= ATTEMPTS || !RETRYABLE.has((e as { code?: string }).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 10 * attempt + Math.floor(Math.random() * 20)));
    }
  }
}

async function executeOnce(pool: pg.Pool, caller: Caller, cmd: Command): Promise<CommandOutcome> {
  const handler = Object.hasOwn(HANDLERS, cmd.name) ? HANDLERS[cmd.name] : undefined;
  if (!handler) throw new CommandError('bad_request', `unknown command ${cmd.name}`);
  const stored = await storedOutcome(pool, caller, cmd);
  if (stored) return stored;
  try {
    return await inTransaction(pool, async (tx) => {
      const role = (await tx.query<{ role: string }>(
        'SELECT role FROM project_memberships WHERE project_id = $1 AND human_id = $2', [cmd.project_id, caller.principal])).rows[0]?.role;
      if (!role) throw new CommandError('forbidden', `${caller.principal} is not a member of ${cmd.project_id}`);
      if (role === 'viewer') throw new CommandError('forbidden', 'viewers cannot send commands');
      // Claim the command_id before running anything: a concurrent retry blocks on this key, then
      // fails on it once we commit, and returns our stored outcome.
      await tx.query(
        'INSERT INTO commands (command_id, project_id, principal, as_agent, name, args) VALUES ($1, $2, $3, $4, $5, $6)',
        [cmd.command_id, cmd.project_id, caller.principal, cmd.as_agent ?? null, cmd.name, JSON.stringify(cmd.args)]);
      const actor = await resolveActor(tx, cmd, caller);
      const out = await handler({ tx, projectId: cmd.project_id, caller, actor }, cmd.args);
      const seqs = await appendEvents(tx, cmd.project_id, out.events.map((e) => ({
        kind: e.kind, data: e.data, actor: actor.principal,
        ...(actor.onBehalfOf ? { onBehalfOf: actor.onBehalfOf } : {}), ...(caller.deviceId ? { deviceId: caller.deviceId } : {}),
      })));
      await tx.query('UPDATE commands SET seqs = $2, result = $3 WHERE command_id = $1', [cmd.command_id, seqs, JSON.stringify(out.result ?? null)]);
      if (seqs.length) await notifyProject(tx, cmd.project_id);
      return { seqs, result: out.result ?? null, duplicate: false };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'commands_pkey')) {
      const raced = await storedOutcome(pool, caller, cmd);
      if (raced) return raced;
    }
    throw e;
  }
}

async function storedOutcome(pool: pg.Pool, caller: Caller, cmd: Command): Promise<CommandOutcome | null> {
  const row = (await pool.query('SELECT project_id, principal, as_agent, name, args, seqs, result FROM commands WHERE command_id = $1', [cmd.command_id])).rows[0];
  if (!row) return null;
  const same = row.project_id === cmd.project_id && row.principal === caller.principal && row.as_agent === (cmd.as_agent ?? null)
    && row.name === cmd.name && isDeepStrictEqual(row.args, cmd.args);
  if (!same) throw new CommandError('conflict', `command_id ${cmd.command_id} was already used for a different command`);
  return { seqs: (row.seqs as string[]).map(Number), result: row.result, duplicate: true };
}

async function resolveActor(tx: pg.PoolClient, cmd: Command, caller: Caller): Promise<Actor> {
  if (!cmd.as_agent) return { principal: caller.principal, onBehalfOf: null };
  const owner = (await tx.query<{ accountable_human_id: string }>(
    'SELECT accountable_human_id FROM agent_principals WHERE id = $1 AND project_id = $2', [cmd.as_agent, cmd.project_id])).rows[0]?.accountable_human_id;
  // Authority comes from the human principal, never from the agent (docs/architecture.md §3).
  if (owner !== caller.principal) throw new CommandError('forbidden', `${cmd.as_agent} is not an agent of ${caller.principal} in this project`);
  return { principal: cmd.as_agent, onBehalfOf: caller.principal };
}
