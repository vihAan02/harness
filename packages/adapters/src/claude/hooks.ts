// setupHooks for Claude Code: in-process SDK callbacks only (agent-adapters.md §5; D-47, D-62, D-70).
// - PreToolUse is the dead-man: registered in every session, with a short timeout, and any throw
//   inside it denies the call. In-process callbacks fail closed on timeout but OPEN on a throw (SP-10).
//   If harnessd dies, nothing answers it, so an orphaned agent's next tool call times out and is denied.
//   It also checks every Read, Grep and Glob against the read policy at call time (D-98), which catches
//   paths the static deny rules couldn't name, such as a sibling worktree created after the session started (F-100).
// - PostToolUse captures edits: file-tool paths, plus `bashEditDiff` for Bash writes (F-07). It
//   fails open, so harnessd backs it up with worktree diffs (D-70).
import fs from 'node:fs';
import path from 'node:path';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessHookSink, ObservedRead, SessionSpec } from '../adapter.ts';
import { readAllowed } from '../readpolicy.ts';

export const DEAD_MAN_TIMEOUT_S = 5;
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

type ToolHookInput = { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: unknown; tool_use_id?: string };
/** Search hits recorded per Grep call, at most. */
const MAX_HITS = 200;
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

/** The fixed part of a glob pattern: everything before its first wildcard, up to a directory. */
function globBase(pattern: string): string {
  const i = pattern.search(/[*?[{]/);
  if (i < 0) return pattern;
  const fixed = pattern.slice(0, i);
  return fixed.endsWith('/') ? fixed : path.dirname(fixed);
}

/**
 * The paths a read tool would touch, for the read check (D-98): Read's file; Grep's and Glob's search
 * root (the cwd if none); and the fixed part of a Glob pattern, which can climb out of its root (`../x/*`).
 */
export function readTargets(input: ToolHookInput, cwd: string): string[] {
  const ti = input.tool_input ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  switch (input.tool_name) {
    case 'Read':
      return [str(ti.file_path) ?? cwd];
    case 'Grep':
      return [str(ti.path) ?? cwd];
    case 'Glob': {
      const root = path.resolve(cwd, str(ti.path) ?? cwd);
      const pattern = str(ti.pattern);
      return pattern ? [root, path.resolve(root, globBase(pattern))] : [root];
    }
    default:
      return [];
  }
}

/** Is `rel` a regular file in the worktree? Used to tell real paths from text in Grep's content output. */
function isFileIn(worktree: string, p: string): boolean {
  try { return fs.statSync(path.resolve(worktree, p)).isFile(); } catch { return false; }
}

/**
 * The files a finished tool call read (0B item 1; coordination.md §2). Read gives one file, with its line
 * range if partial (high confidence). Grep gives the files it returned matches from (medium): its
 * `filenames`, or, in content and count modes, the paths at the start of its output lines, kept only if
 * they name a real file. Glob names files without reading them, so it's not a read.
 */
export function readsOf(input: ToolHookInput, worktree: string): { reads: ObservedRead[]; outside: string[] } {
  const ti = input.tool_input ?? {};
  const found: { p: string; range?: { start: number; lines: number } }[] = [];
  let source: ObservedRead['source'] = 'read_tool';
  if (input.tool_name === 'Read' && typeof ti.file_path === 'string') {
    const limit = Number(ti.limit);
    const offset = Number(ti.offset);
    found.push({ p: ti.file_path, ...(Number.isSafeInteger(limit) && limit > 0 ? { range: { start: Number.isSafeInteger(offset) && offset > 0 ? offset : 1, lines: limit } } : {}) });
  } else if (input.tool_name === 'Grep') {
    source = 'search_hit';
    const out = (input.tool_response ?? {}) as { mode?: string; filenames?: unknown; content?: unknown };
    const target = typeof ti.path === 'string' ? ti.path : null;
    if (target && isFileIn(worktree, target)) {
      if ((typeof out.content === 'string' && out.content.trim()) || (Array.isArray(out.filenames) && out.filenames.length)) found.push({ p: target });
    } else if (Array.isArray(out.filenames) && out.filenames.length) {
      for (const f of out.filenames.slice(0, MAX_HITS)) if (typeof f === 'string') found.push({ p: f });
    } else if (typeof out.content === 'string') {
      const seen = new Set<string>();
      const searchDir = target ? path.resolve(worktree, target) : worktree;
      for (const line of out.content.split('\n')) {
        // "path:12:text", "path-12-context" or "path:3" (count). A file name can itself contain "-12-", so try
        // every split point, longest prefix first, and keep the one that names a real file (relative to the
        // working directory, or to the searched directory).
        const cuts: string[] = [];
        for (const m of line.matchAll(/[:-]\d+(?=[:-]|$)/g)) cuts.push(line.slice(0, m.index));
        let hit: string | null = null;
        for (const prefix of cuts.reverse()) {
          if (!prefix) continue;
          if (seen.has(prefix)) break; // this file is already recorded
          const candidates = path.isAbsolute(prefix) ? [prefix] : [path.resolve(worktree, prefix), path.resolve(searchDir, prefix)];
          const real = candidates.find((c) => isFileIn(worktree, c));
          if (real) { seen.add(prefix); hit = real; break; }
        }
        if (hit) found.push({ p: hit });
        if (seen.size >= MAX_HITS) break;
      }
    }
  }
  const reads: ObservedRead[] = [];
  const outside: string[] = [];
  for (const f of found) {
    const r = relativize(worktree, [path.resolve(worktree, f.p)]);
    outside.push(...r.outside);
    for (const p of r.paths) reads.push({ path: p, source, confidence: source === 'read_tool' ? 'high' : 'medium', ...(f.range ? { range: f.range } : {}) });
  }
  return { reads, outside };
}

export function claudeHooks(spec: Pick<SessionSpec, 'worktree' | 'readPolicy'>, sink: HarnessHookSink): ClaudeHookBundle {
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
      // Read confinement at call time, behind the static deny rules and the sandbox (D-61, D-98).
      if (spec.readPolicy && READ_TOOLS.has(input.tool_name ?? '')) {
        // The CLI expands a leading ~ in some fields (Grep's and Glob's path) after this hook has seen it,
        // so a ~ path can't be judged here: refuse it. Agents work in their worktree, by absolute or
        // relative path.
        const ti = input.tool_input ?? {};
        const pathFields = input.tool_name === 'Read' ? ['file_path'] : input.tool_name === 'Glob' ? ['path', 'pattern'] : ['path'];
        if (pathFields.some((k) => typeof ti[k] === 'string' && (ti[k] as string).trimStart().startsWith('~'))) {
          return deny('the harness doesn\'t accept ~ paths; use a path inside this task\'s worktree');
        }
        const blocked = readTargets(input, spec.worktree).find((p) => !readAllowed(spec.readPolicy!, p, spec.worktree));
        if (blocked) return deny(`the harness confines reads to this task's worktree; ${blocked} is outside it`);
      }
      return {};
    } catch {
      return deny('harness supervisor error'); // D-62: never fail open
    }
  };
  const postToolUse = async (raw: unknown) => {
    try {
      const input = raw as ToolHookInput;
      const id = String(input.tool_use_id ?? '');
      sink.observe({ kind: 'hook.seen', toolUseId: id, tool: String(input.tool_name ?? ''), event: 'post' });
      const paths = editedPaths(input);
      if (paths.length) sink.observe({ kind: 'edit.observed', ...relativize(spec.worktree, paths) });
      const r = readsOf(input, spec.worktree);
      if (r.reads.length || r.outside.length) sink.observe({ kind: 'read.observed', toolUseId: id, ...r });
      const command = input.tool_input?.command;
      if (input.tool_name === 'Bash' && typeof command === 'string') sink.observe({ kind: 'shell.ran', toolUseId: id, command: command.slice(0, 10_000) });
    } catch {
      // Fails open by design; worktree diffs catch missed edits (D-70), and the monitor counts missed hooks (H-03).
    }
    return {};
  };
  const postToolUseFailure = async (raw: unknown) => {
    try {
      const input = raw as ToolHookInput;
      sink.observe({ kind: 'hook.seen', toolUseId: String(input.tool_use_id ?? ''), tool: String(input.tool_name ?? ''), event: 'post_failure' });
    } catch {
      // Fails open, like PostToolUse.
    }
    return {};
  };
  return {
    PreToolUse: [{ timeout: DEAD_MAN_TIMEOUT_S, hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
  };
}
