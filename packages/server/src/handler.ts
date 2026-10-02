// What a command handler sees and returns. Handlers live one module per area and are registered
// in commands.ts, which runs them inside the command's transaction.
import type pg from 'pg';
import type { ErrorCode } from '@harness/protocol';

export class CommandError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Who is on the other end of the connection: a human, optionally on a registered device. */
export type Caller = { principal: string; deviceId: string | null };
/** Who the command's events are attributed to: the caller, or one of the caller's agents. */
export type Actor = { principal: string; onBehalfOf: string | null };
export type HandlerContext = { tx: pg.PoolClient; projectId: string; caller: Caller; actor: Actor };
export type HandlerOutput = { result: unknown; events: { kind: string; data: unknown }[] };
export type Handler = (ctx: HandlerContext, args: Record<string, unknown>) => Promise<HandlerOutput>;
