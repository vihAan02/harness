// What every agent-facing tool module shares (protocol.md §6): the context a tool runs in, and the
// helper that sends a protocol command for the agent and turns its outcome into a tool result.
import type { ToolResult } from '@harness/adapters';
import { CommandFailed } from '../link.ts';
import type { ProjectView } from '../view.ts';

export type ToolContext = {
  view: ProjectView;
  agentId: string;
  taskId: string;
  /** The agent's session, for commands about it (`wait.start`). */
  sessionId?: string;
  /** Sends a command for this agent. Resolves with the command's result. */
  send: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** How long a tool waits for the server before telling the agent the command is queued. */
  timeoutMs?: number;
};

/** Sends one command for the agent; `ok` renders its result. Errors and timeouts become error results, never throws. */
export type CommandCall = (name: string, args: Record<string, unknown>, ok: (result: unknown) => string) => Promise<ToolResult>;

export function commandCall(ctx: ToolContext): CommandCall {
  return async (name, args, ok) => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), ctx.timeoutMs ?? 15_000); });
    try {
      const result = await Promise.race([ctx.send(name, args), timeout]);
      if (result === 'timeout') {
        // The command stays queued and is resent on reconnect (it's idempotent), so say so rather than "failed".
        return { text: 'The coordination server did not answer in time. The request is queued and will be sent when it reconnects; don\'t send it again.', isError: true };
      }
      return { text: ok(result) };
    } catch (e) {
      const msg = e instanceof CommandFailed ? e.message : `harness error: ${(e as Error).message}`;
      return { text: msg, isError: true };
    } finally {
      clearTimeout(timer);
    }
  };
}
