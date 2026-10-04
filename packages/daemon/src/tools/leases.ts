// Agent tools for hard claims: `claim(paths, ttl_s?)` and `release(lease_ids)` (0B item 5; D-97,
// protocol.md §6). Stream B builds them here (D-94). The names below are pinned: the shim test checks
// that the model is offered exactly these, so add a tool here and its name together.
import type { HarnessTool } from '@harness/adapters';
import type { CommandCall, ToolContext } from './common.ts';

export const LEASE_TOOL_NAMES: readonly string[] = [];

export function leaseTools(_ctx: ToolContext, _call: CommandCall): HarnessTool[] {
  return [];
}
