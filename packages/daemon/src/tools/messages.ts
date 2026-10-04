// Agent tools for the 0B message kinds: `report_blocked(on, reason)` and `request_contract(to, contract)`
// (0B item 6; D-24, protocol.md §6). Stream B builds them here (D-94). The names below are pinned: the
// shim test checks that the model is offered exactly these, so add a tool here and its name together.
import type { HarnessTool } from '@harness/adapters';
import type { CommandCall, ToolContext } from './common.ts';

export const MESSAGE_TOOL_NAMES: readonly string[] = [];

export function messageTools(_ctx: ToolContext, _call: CommandCall): HarnessTool[] {
  return [];
}
