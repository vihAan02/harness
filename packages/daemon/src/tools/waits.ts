// The agent tool for waiting: `wait_for(kind, id, timeout_s?)` (0B item 4; D-95, protocol.md §6). It records
// the wait and returns at once; the agent then ends its turn, and harnessd pushes the outcome when the wait
// settles (D-101). The names below are pinned: the shim test checks that the model is offered exactly these.
import type { HarnessTool } from '@harness/adapters';
import type { CommandCall, ToolContext } from './common.ts';

export const WAIT_TOOL_NAMES: readonly string[] = ['wait_for'];

/** The server's default and bounds for a wait's timeout, in seconds (D-95). */
export const WAIT_TIMEOUT = { default: 600, min: 10, max: 3600 };

const WAITABLE = ['answer', 'task', 'lease'];

/** What a settled wait's result says, in words. */
export function describeResult(kind: string, result: Record<string, unknown> | undefined): string {
  if (kind === 'answer') return `the answer arrived (${String(result?.answer_id ?? 'unknown')}); it reaches you as a harness message`;
  if (kind === 'task') return `the task is ${String(result?.status ?? 'finished')}`;
  if (kind === 'lease') return result?.lease === 'expired' ? 'the lease expired' : 'the lease was released';
  return 'it happened';
}

export function waitTools(ctx: ToolContext, call: CommandCall): HarnessTool[] {
  return [
    {
      name: 'wait_for',
      description: 'Wait until something you need has happened: the answer to a question you asked (kind "answer", the question_id), '
        + 'another task finishing (kind "task", its ID, e.g. T-3), or a lease freeing up (kind "lease", its lease_id). '
        + 'Returns at once. If it hasn\'t happened yet, end your turn: the harness starts your next turn when it does, '
        + `or when the timeout passes (default ${WAIT_TIMEOUT.default} seconds). One wait at a time.`,
      params: {
        kind: { type: 'string', description: 'answer, task or lease', maxLength: 10 },
        id: { type: 'string', description: 'The question_id, task ID or lease_id', maxLength: 100 },
        timeout_s: { type: 'number', description: `Seconds to wait at most (${WAIT_TIMEOUT.min} to ${WAIT_TIMEOUT.max})`, optional: true, min: WAIT_TIMEOUT.min, max: WAIT_TIMEOUT.max },
      },
      run: async (a) => {
        const kind = String(a.kind);
        if (!WAITABLE.includes(kind)) return { text: `kind must be one of: ${WAITABLE.join(', ')}`, isError: true };
        if (!ctx.sessionId) return { text: 'harness error: this session can\'t wait', isError: true };
        const timeout = typeof a.timeout_s === 'number' ? a.timeout_s : WAIT_TIMEOUT.default;
        return call('wait.start', { session_id: ctx.sessionId, on: { kind, id: a.id }, ...(typeof a.timeout_s === 'number' ? { timeout_s: a.timeout_s } : {}) }, (r) => {
          const w = r as { wait_id: string; outcome: string; result?: Record<string, unknown> };
          return w.outcome === 'resolved'
            ? `It has already happened: ${describeResult(kind, w.result)}. Carry on.`
            : `Waiting (wait_id ${w.wait_id}). End your turn now. The harness starts your next turn when it happens, or after ${timeout} seconds if it doesn't.`;
        });
      },
    },
  ];
}

/** What a wait was for, in words. */
function waitedFor(on: { kind: string; id: string }): string {
  if (on.kind === 'answer') return `the answer to ${on.id}`;
  if (on.kind === 'task') return `task ${on.id} to finish`;
  if (on.kind === 'lease') return `lease ${on.id} to free up`;
  return on.id;
}

/** The notice harnessd pushes when an agent's wait settles (D-101): a fact, not an instruction (F-10). */
export function waitOutcomeText(w: { on: { kind: string; id: string }; outcome: string; result?: Record<string, unknown>; startedAt: string; timeoutAt: string }): string {
  if (w.outcome === 'resolved') return `Your wait for ${waitedFor(w.on)} is over: ${describeResult(w.on.kind, w.result)}.`;
  const secs = Math.max(0, Math.round((Date.parse(w.timeoutAt) - Date.parse(w.startedAt)) / 1000));
  return `Your wait for ${waitedFor(w.on)} timed out after ${secs} seconds without it happening, and your human has been told. You can carry on without it, or wait again.`;
}
