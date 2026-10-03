// Read capture on the harnessd side (0B item 1; D-22, D-23, D-88; coordination.md §2). The adapter reports
// which files an agent read; harnessd hashes each one from disk at that moment, as a Git blob id, so a later
// land can compare it straight from the tree. Only regular files inside the worktree are hashed, never
// .git, never what a symlink points at outside it, and never Git-ignored files (dependencies, build
// output). Entries are batched and reported with `readset.add`; paths and hashes only, never contents.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.ts';

/** Bigger files are recorded without a hash (always "changed"): hashing runs on the observation path. */
export const MAX_HASH_BYTES = 16 * 1024 * 1024;
export type ObjectFormat = 'sha1' | 'sha256';
export type ReadSource = 'read_tool' | 'search_hit' | 'shell_heuristic' | 'edit_base' | 'instructions';
export type Confidence = 'high' | 'medium' | 'low';
export type ReadReport = { path: string; hash: string | null; source: ReadSource; confidence: Confidence; range?: { start: number; lines: number } };

/** The Git blob id of some content, as `git hash-object` computes it (no filters applied). */
export function blobId(bytes: Buffer, format: ObjectFormat = 'sha1'): string {
  return crypto.createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export async function objectFormat(worktree: string): Promise<ObjectFormat> {
  try {
    return (await git(worktree, 'rev-parse', '--show-object-format')) === 'sha256' ? 'sha256' : 'sha1';
  } catch {
    return 'sha1';
  }
}

/**
 * The hash to record for a read of `rel` in the worktree (a real path). `undefined`: not a file the
 * agent's worktree owns, so nothing is recorded. `null`: recorded, but its content isn't hashed (a
 * symlink, or too big), which always counts as changed later: the safe direction.
 */
export function hashForRead(worktree: string, rel: string, format: ObjectFormat): string | null | undefined {
  // `.git` in any case: macOS file systems are usually case-insensitive.
  if (!rel || path.isAbsolute(rel) || rel.split('/').some((s) => s === '..' || s.toLowerCase() === '.git')) return undefined;
  let root: string;
  try { root = fs.realpathSync(worktree); } catch { return undefined; }
  const abs = path.join(root, rel);
  const insideRoot = (p: string) => {
    const r = path.relative(root, p);
    return !!r && !r.startsWith('..') && !path.isAbsolute(r) && r.split(path.sep)[0]!.toLowerCase() !== '.git';
  };
  let st: fs.Stats;
  let real: string;
  try {
    st = fs.lstatSync(abs);
    real = fs.realpathSync(abs);
  } catch {
    return undefined; // a read of a file that doesn't exist reads nothing
  }
  if (!insideRoot(real)) return undefined;
  if (st.isSymbolicLink()) return null; // Git stores the link, not its target: no comparable hash
  if (!st.isFile()) return undefined;
  if (st.size > MAX_HASH_BYTES) return null;
  // Read through a descriptor opened without following a symlink and without blocking (a FIFO swapped in
  // after the checks above never hangs harnessd), and only if it's still the regular file that was checked.
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev || fst.size > MAX_HASH_BYTES) return fst.isFile() ? null : undefined;
    if (!insideRoot(fs.realpathSync(abs))) return undefined;
    return blobId(fs.readFileSync(fd), format);
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Which of these worktree paths Git ignores (dependencies, build output, local env files). */
export function ignoredPaths(worktree: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'check-ignore', '-z', '--stdin'],
      { cwd: worktree, env, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
        // Exit 1 means "none ignored"; anything else unexpected also counts as none (record rather than drop).
        resolve(new Set(String(stdout ?? '').split('\0').filter(Boolean)));
      });
    child.stdin?.on('error', () => {}); // git exiting early (EPIPE) must never crash harnessd
    child.stdin?.end(paths.join('\0') + '\0');
  });
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** A range the server accepts (start ≥ 1, lines ≥ 1), or none: one bad entry would refuse the whole batch. */
function validRange(r: ReadReport): ReadReport {
  if (!r.range) return r;
  const ok = Number.isSafeInteger(r.range.start) && Number.isSafeInteger(r.range.lines) && r.range.start >= 1 && r.range.lines >= 1;
  if (ok) return r;
  const { range: _drop, ...rest } = r;
  return rest;
}

/**
 * One session's read reporting. `record` hashes at once (the content the agent just saw) and queues;
 * `flush` drops ignored files and repeats, and sends batches of at most 200 in order. Never throws into
 * the observation loop: a failed report is logged, and the next read of the file reports it again.
 */
export class ReadTracker {
  pending = new Map<string, ReadReport>();
  /** What the server last heard, per path, so re-reading unchanged content sends nothing. */
  sent = new Map<string, { hash: string | null; confidence: Confidence }>();
  chain: Promise<void> = Promise.resolve();
  timer: NodeJS.Timeout | null = null;
  counts: Record<ReadSource, number> = { read_tool: 0, search_hit: 0, shell_heuristic: 0, edit_base: 0, instructions: 0 };
  format: ObjectFormat = 'sha1';
  o: { worktree: string; send: (entries: ReadReport[]) => Promise<void>; log: (m: string) => void; debounceMs?: number };

  constructor(o: ReadTracker['o']) {
    this.o = o;
  }

  async init(): Promise<void> {
    this.format = await objectFormat(this.o.worktree);
  }

  /** Records reads of worktree-relative paths. Returns how many were recordable. */
  record(reads: { path: string; source: ReadSource; confidence: Confidence; range?: { start: number; lines: number } }[]): number {
    let n = 0;
    for (const r of reads) {
      const hash = hashForRead(this.o.worktree, r.path, this.format);
      if (hash === undefined) continue;
      n++;
      this.counts[r.source]++;
      const prev = this.pending.get(r.path);
      // A stronger capture of the same content wins; otherwise the newest read does.
      if (prev && prev.hash === hash && RANK[prev.confidence] > RANK[r.confidence]) continue;
      this.pending.set(r.path, { path: r.path, hash, source: r.source, confidence: r.confidence, ...(r.range ? { range: r.range } : {}) });
    }
    if (n) this.schedule();
    return n;
  }

  /** True if this session has reported, or is about to report, a read of `path`. */
  knows(path: string): boolean {
    return this.sent.has(path) || this.pending.has(path);
  }

  /** Records entries whose hash harnessd already knows (edit bases, read from Git rather than disk). */
  recordHashed(entries: ReadReport[]): void {
    for (const e of entries) {
      this.counts[e.source]++;
      if (!this.pending.has(e.path)) this.pending.set(e.path, e);
    }
    if (entries.length) this.schedule();
  }

  /** After a sync, these paths' entries are stale on the server: the next read must be reported again. */
  forget(paths: string[]): void {
    for (const p of paths) this.sent.delete(p);
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.o.debounceMs ?? 250);
  }

  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const batch = [...this.pending.values()];
    this.pending.clear();
    const next = this.chain.then(async () => {
      if (!batch.length) return;
      const ignored = await ignoredPaths(this.o.worktree, batch.map((r) => r.path));
      const fresh = batch.map((r) => validRange(r)).filter((r) => {
        if (ignored.has(r.path)) return false;
        const s = this.sent.get(r.path);
        return !(s && s.hash === r.hash && r.hash !== null && RANK[s.confidence] >= RANK[r.confidence]);
      });
      for (let i = 0; i < fresh.length; i += 200) {
        const chunk = fresh.slice(i, i + 200);
        try {
          await this.o.send(chunk);
          for (const r of chunk) this.sent.set(r.path, { hash: r.hash, confidence: r.confidence });
        } catch (e) {
          this.o.log(`read report failed: ${(e as Error).message}`);
        }
      }
    });
    this.chain = next.catch(() => {});
    return this.chain;
  }
}
