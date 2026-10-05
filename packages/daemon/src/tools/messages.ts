// Agent tools for the 0B message kinds: `request_contract(to, contract, about_paths?)` and
// `report_blocked(reason, on?)` (0B item 6; D-24, D-105, protocol.md §6). The names below are pinned: the
// shim test checks that the model is offered exactly these, so add a tool here and its name together.
import type { HarnessTool } from '@harness/adapters';
import type { CommandCall, ToolContext } from './common.ts';

export const MESSAGE_TOOL_NAMES: readonly string[] = ['request_contract', 'report_blocked'];

/** What `on` names: an agent (agent/backend), a task (T-3), or a question or contract request (msg_…). */
export function blockedOn(on: string): { kind: 'agent' | 'task' | 'question'; id: string } | null {
  if (/^T-\d{1,9}$/.test(on)) return { kind: 'task', id: on };
  if (/^msg_[0-9a-f]{16}$/.test(on)) return { kind: 'question', id: on };
  if (/^agent[/_][A-Za-z0-9._-]{1,60}$/.test(on)) return { kind: 'agent', id: on };
  return null;
}

export function messageTools(ctx: ToolContext, call: CommandCall): HarnessTool[] {
  return [
    {
      name: 'request_contract',
      description: 'Ask another agent to define or confirm a contract you depend on: an API, a type or a schema they own (at most 500 characters). '
        + 'Returns a request_id at once; the reply arrives later as a harness message. To wait for it, call wait_for with kind "answer" and the request_id, then end your turn.',
      params: {
        to: { type: 'string', description: 'The agent that owns the contract, e.g. agent/backend (see harness_status)', maxLength: 100 },
        contract: { type: 'string', description: 'What you need defined or confirmed, e.g. the response shape of POST /login', maxLength: 500 },
        about_paths: { type: 'string[]', description: 'Files the contract lives in, if you know them', optional: true },
      },
      run: (a) => call('message.send', { kind: 'contract_request', to: a.to, text: a.contract, ...(a.about_paths ? { about_paths: a.about_paths } : {}) },
        (r) => `Sent. request_id: ${(r as { message_id: string }).message_id}. The reply will arrive as a harness message.`),
    },
    {
      name: 'report_blocked',
      description: 'Tell your human that your task can\'t go on, and why (at most 500 characters). Use it when you need a decision, '
        + 'access or work only a person can give. It doesn\'t pause or end your task: keep working on what you can, or wait_for what you\'re blocked on and end your turn.',
      params: {
        reason: { type: 'string', description: 'What you need, and why the task can\'t go on without it', maxLength: 500 },
        on: { type: 'string', description: 'What you\'re blocked on, if it\'s one thing: an agent (agent/backend), a task (T-3), or a question or request (its ID)', optional: true, maxLength: 100 },
      },
      run: async (a) => {
        const on = typeof a.on === 'string' && a.on ? blockedOn(a.on) : null;
        if (a.on && !on) return { text: '`on` must be an agent (agent/backend), a task (T-3) or a question or request ID (msg_…); or leave it out', isError: true };
        const owner = ctx.view.tasks.get(ctx.taskId)?.ownerHumanId;
        return call('message.send', { kind: 'task_blocked', text: a.reason, ...(on ? { blocked_on: on } : {}) },
          () => `Reported to ${owner ? `human/${owner}` : 'your human'}: ${ctx.taskId} is blocked. It stays in progress.`);
      },
    },
  ];
}
