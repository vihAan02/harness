import { isAbsolute, join } from "node:path";

/**
 * Files an `apply_patch` call touches. Codex sends the whole patch envelope as `tool_input.command`:
 *
 *   *** Begin Patch
 *   *** Update File: src/a.ts
 *   *** Move to: src/b.ts
 *   @@ ...
 *   *** Add File: src/new.ts
 *   *** Delete File: src/old.ts
 *   *** End Patch
 *
 * Paths may be relative to the session's cwd or absolute; both source and destination of a move count.
 */
export function applyPatchPaths(patch: string, cwd?: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Update File|Add File|Delete File|Move to):\s*(.+?)\s*$/gm;
  for (const m of patch.matchAll(re)) {
    const p = m[1]!;
    const abs = cwd && !isAbsolute(p) ? join(cwd, p) : p;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}
