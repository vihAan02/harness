import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DiffFile, Hunk } from "@mp/protocol";
import { git } from "./git.ts";

const MAX_UNTRACKED_FILES = 500;
const MAX_UNTRACKED_BYTES = 1_000_000;

/** Undoes git's C-style quoting of unusual paths (`"a\tb"`). */
export function unquoteGitPath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[++i]!;
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string, prefix: "a/" | "b/"): string | null {
  const s = unquoteGitPath(p.replace(/\t$/, ""));
  if (s === "/dev/null") return null;
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/** Best-effort path from `diff --git a/X b/X` when there are no ---/+++ lines (mode-only or pure renames). */
function pathFromHeader(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) return null;
  if ((rest.length - 1) % 2 !== 0) return null;
  const half = (rest.length - 1) / 2;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  return a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2) ? a.slice(2) : null;
}

interface Building {
  file: DiffFile;
  lines: string[];
  headerPath: string | null;
}

/**
 * Parses `git diff` output into DiffFiles. Hunk bodies are consumed using the line counts in each
 * `@@` header, so a deleted line that happens to start with `-- ` is never mistaken for a header.
 * Hunks are the exact changed line ranges (context excluded), so collision checks aren't fooled by
 * the 3 lines of context git adds.
 */
export function parseUnifiedDiff(text: string, opts: { includePatch?: boolean } = {}): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: Building | null = null;
  let oldLine = 0;
  let newLine = 0;
  let remOld = 0;
  let remNew = 0;
  let run: Hunk | null = null;

  const closeRun = () => {
    if (!cur || !run) return;
    // Unified-diff convention: an empty side's start is the line *before* the change.
    if (run.oldLines === 0) run.oldStart = Math.max(0, run.oldStart - 1);
    if (run.newLines === 0) run.newStart = Math.max(0, run.newStart - 1);
    cur.file.hunks.push(run);
    run = null;
  };
  const finish = () => {
    if (!cur) return;
    closeRun();
    if (!cur.file.path && cur.headerPath) cur.file.path = cur.headerPath;
    if (!cur.file.path && cur.file.oldPath) cur.file.path = cur.file.oldPath;
    if (opts.includePatch) cur.file.patch = cur.lines.join("\n") + "\n";
    if (cur.file.path) files.push(cur.file);
    cur = null;
  };

  for (const line of text.split("\n")) {
    if (cur && (remOld > 0 || remNew > 0)) {
      const c: Building = cur;
      c.lines.push(line);
      const first = line[0];
      if (first === "+") {
        run ??= { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0 };
        run.newLines++;
        newLine++;
        remNew--;
        c.file.additions++;
      } else if (first === "-") {
        run ??= { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0 };
        run.oldLines++;
        oldLine++;
        remOld--;
        c.file.deletions++;
      } else if (first === "\\") {
        // "\ No newline at end of file"
      } else {
        // Context (" "), or an empty line from tools that strip trailing whitespace.
        closeRun();
        oldLine++;
        newLine++;
        remOld--;
        remNew--;
      }
      if (remOld <= 0 && remNew <= 0) closeRun();
      continue;
    }

    if (line.startsWith("diff --git ")) {
      finish();
      cur = {
        file: { path: "", status: "modified", additions: 0, deletions: 0, hunks: [] },
        lines: [line],
        headerPath: pathFromHeader(line),
      };
      continue;
    }
    if (!cur || line === "") continue;
    const c: Building = cur;
    c.lines.push(line);

    if (line.startsWith("@@")) {
      closeRun();
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        oldLine = Number(m[1]);
        remOld = m[2] === undefined ? 1 : Number(m[2]);
        newLine = Number(m[3]);
        remNew = m[4] === undefined ? 1 : Number(m[4]);
        // An empty side's start is the line before the hunk; bodies advance from the next line.
        if (remOld === 0) oldLine++;
        if (remNew === 0) newLine++;
      }
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" after the last line of a hunk.
    } else if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4), "a/");
      if (p === null) c.file.status = "added";
      else c.file.oldPath ??= p;
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4), "b/");
      if (p === null) c.file.status = "deleted";
      else c.file.path = p;
    } else if (line.startsWith("new file mode")) {
      c.file.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      c.file.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      c.file.status = "renamed";
      c.file.oldPath = unquoteGitPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      c.file.status = "renamed";
      c.file.path = unquoteGitPath(line.slice("rename to ".length));
    } else if (line.startsWith("Binary files ")) {
      const m = /^Binary files (.+) and (.+) differ$/.exec(line);
      if (m) {
        const a = stripPrefix(m[1]!, "a/");
        const b = stripPrefix(m[2]!, "b/");
        if (a === null) c.file.status = "added";
        if (b === null) c.file.status = "deleted";
        c.file.path = b ?? a ?? c.file.path;
      }
    }
  }
  finish();

  for (const f of files) {
    if (f.status !== "renamed" || f.oldPath === f.path) delete f.oldPath;
  }
  return files;
}

async function readUntracked(worktree: string, rel: string, includePatch: boolean): Promise<DiffFile | null> {
  const abs = join(worktree, rel);
  let size: number;
  try {
    const s = await stat(abs);
    if (!s.isFile()) return null;
    size = s.size;
  } catch {
    return null;
  }
  const base: DiffFile = { path: rel, status: "added", additions: 0, deletions: 0, hunks: [] };
  if (size > MAX_UNTRACKED_BYTES) return { ...base, truncated: true };
  const fh = await open(abs, "r");
  try {
    const buf = await fh.readFile();
    if (buf.subarray(0, 8000).includes(0)) return base; // binary
    const text = buf.toString("utf8");
    const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
    const file: DiffFile = {
      ...base,
      additions: lines.length,
      hunks: lines.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length }] : [],
    };
    if (includePatch) {
      file.patch =
        `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n` +
        (lines.length ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n` : "");
    }
    return file;
  } finally {
    await fh.close();
  }
}

export interface LiveDiffResult {
  mergeBase: string;
  files: DiffFile[];
}

/**
 * Everything this agent has changed relative to where its branch left `baseRef`:
 * committed on its branch, staged, unstaged, and untracked files.
 */
export async function computeLiveDiff(
  worktree: string,
  baseRef: string,
  opts: { includePatch?: boolean } = {},
): Promise<LiveDiffResult> {
  const includePatch = opts.includePatch ?? true;
  const mergeBase = (await git(worktree, ["merge-base", "HEAD", baseRef])).stdout.trim();
  const diff = await git(worktree, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "-U3",
    mergeBase,
    "--",
  ]);
  const files = parseUnifiedDiff(diff.stdout, { includePatch });

  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const paths = untracked.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED_FILES);
  for (const rel of paths) {
    const f = await readUntracked(worktree, rel, includePatch);
    if (f) files.push(f);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { mergeBase, files };
}
