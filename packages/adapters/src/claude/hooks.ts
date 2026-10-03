// setupHooks for Claude Code: in-process SDK callbacks only (agent-adapters.md §5; D-47, D-62, D-70).
// - PreToolUse is the dead-man: registered in every session, with a short timeout, and any throw
//   inside it denies the call. In-process callbacks fail closed on timeout but OPEN on a throw (SP-10).
//   If harnessd dies, nothing answers it, so an orphaned agent's next tool call times out and is denied.
// - PostToolUse captures edits: file-tool paths, plus `bashEditDiff` for Bash writes (F-07). It
//   fails open, so harnessd backs it up with worktree diffs (D-70).
import path from 'node:path';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessHookSink, SessionSpec } from '../adapter.ts';

export const DEAD_MAN_TIMEOUT_S = 5;
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

type ToolHookInput = { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown };
export type ClaudeHookBundle = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

const deny = (reason: string) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
});

/** Splits absolute paths into worktree-relative ones and ones outside the worktree. */
export function relativize(worktree: string, paths: string[]): { paths: string[]; outside: string[] } {
  const inside = new Set<string>();
  const outside = new Set<string>();
  for (const p of paths) {
    const resolved = path.resolve(worktree, p);
    const rel = path.relative(worktree, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) outside.add(resolved);
    else inside.add(rel.split(path.sep).join('/'));
  }
  return { paths: [...inside].sort(), outside: [...outside].sort() };
}

/** The paths a finished tool call wrote, from its PostToolUse payload (SP-03). */
export function editedPaths(input: ToolHookInput): string[] {
  const name = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  if (FILE_TOOLS.has(name)) {
    const p = ti.file_path ?? ti.notebook_path;
    return typeof p === 'string' ? [p] : [];
  }
  if (name === 'Bash') {
    const diff = (input.tool_response as { bashEditDiff?: { files?: { filePath?: unknown }[]; changedFiles?: unknown[] } } | undefined)?.bashEditDiff;
    if (!diff) return [];
    const files = (diff.files ?? []).map((f) => f.filePath);
    return [...files, ...(diff.changedFiles ?? [])].filter((p): p is string => typeof p === 'string');
  }
  return [];
}

export function claudeHooks(spec: Pick<SessionSpec, 'worktree'>, sink: HarnessHookSink): ClaudeHookBundle {
  const preToolUse = async (raw: unknown) => {
    try {
      const input = raw as ToolHookInput;
      const veto = await sink.gate?.();
      if (veto) return deny(veto);
      // Defense in depth behind the path-scoped allow rules (D-35, D-60): a file tool never writes outside the worktree.
      if (FILE_TOOLS.has(input.tool_name ?? '')) {
        const { outside } = relativize(spec.worktree, editedPaths(input));
        if (outside.length) return deny('the harness only allows edits inside this task\'s worktree');
      }
      return {};
    } catch {
      return deny('harness supervisor error'); // D-62: never fail open
    }
  };
  const postToolUse = async (raw: unknown) => {
    try {
      const paths = editedPaths(raw as ToolHookInput);
      if (paths.length) sink.observe({ kind: 'edit.observed', ...relativize(spec.worktree, paths) });
    } catch {
      // Fails open by design; worktree diffs catch what this misses (D-70).
    }
    return {};
  };
  return {
    PreToolUse: [{ timeout: DEAD_MAN_TIMEOUT_S, hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
  };
}
