// Agent tools for hard claims: `claim(paths, ttl_s?)` and `release(lease_ids)` (0B item 5; D-97,
// protocol.md §6). The names below are pinned: the shim test checks that the model is offered exactly
// these, so add a tool here and its name together. Leases are optional: most work needs only soft claims.
import type { HarnessTool } from '@harness/adapters';
import type { CommandCall, ToolContext } from './common.ts';

export const LEASE_TOOL_NAMES: readonly string[] = ['claim', 'release'];

type Granted = { lease_id: string; path: string; token: number; expires_at: string };
type Conflict = { path: string; lease_id: string; task_id: string; expires_at: string };
const clock = (iso: string) => `${iso.slice(11, 19)} UTC`;

export function leaseTools(ctx: ToolContext, call: CommandCall): HarnessTool[] {
  return [
    {
      name: 'claim',
      description: 'Take a hard claim (a lease) on folders or files you must change before anyone else lands changes to them, e.g. a shared contract. Optional: your task\'s scope already tells others what you\'re working on. All or nothing: if another task holds an overlapping lease, nothing is granted and you\'re told who holds it. The harness renews your leases until your task lands or is abandoned.',
      params: {
        paths: { type: 'string[]', description: 'Folders (src/api/) or files (src/types.ts), at most 50' },
        ttl_s: { type: 'number', description: 'Seconds each lease lasts between renewals (10 to 3600; default 120)', optional: true, min: 10, max: 3600 },
      },
      run: (a) => call('lease.acquire', { task_id: ctx.taskId, paths: a.paths, ...(a.ttl_s !== undefined ? { ttl_s: a.ttl_s } : {}) }, (r) => {
        const { granted, conflicts } = r as { granted: Granted[]; conflicts: Conflict[] };
        if (!granted.length) return `Not granted: ${conflicts.map((c) => `${c.path} overlaps lease ${c.lease_id} of ${c.task_id} until ${clock(c.expires_at)}`).join('; ')}.`;
        return `Granted:\n${granted.map((g) => `- ${g.path}: lease ${g.lease_id}, token ${g.token}, renewed by the harness (expires ${clock(g.expires_at)} unless renewed)`).join('\n')}`;
      }),
    },
    {
      name: 'release',
      description: 'Give back hard claims you no longer need, by lease id (from `claim` or `harness_status`), so other tasks can take them.',
      params: { lease_ids: { type: 'string[]', description: 'The lease ids to release' } },
      run: (a) => call('lease.release', { lease_ids: a.lease_ids }, (r) => {
        const { released } = r as { released: string[] };
        return released.length ? `Released ${released.join(', ')}.` : 'Nothing to release: those leases had already ended.';
      }),
    },
  ];
}
