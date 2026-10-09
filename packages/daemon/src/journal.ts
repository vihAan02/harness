// The per-task write-ahead journal (D-113). Before harnessd acts on a lifecycle event, and before each step's side
// effects, it appends a record here with fsync, so a crash at any point leaves enough to reconcile from at the next
// start: what was received (before the event cursor can move past it), the worktree's base, setup, each session,
// the commit, and later the push, the PR and the integration. One JSON line per record; append-only.
// - Files live under ~/.harness/journal/<epoch>/<project>/<task>.jsonl. A new coordinator (another epoch) never
//   reads the old journals (D-113).
// - A torn last line (a crash mid-write) is ignored. Any other unreadable line moves the file to quarantine/ and
//   the task starts from nothing: never a crash loop.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, type Home } from './home.ts';
import { TASK_ID } from './git.ts';

/** The steps, in the order a task goes through them. Later cards add their own (pushed, pr, integrating, …). */
export type JournalState =
  | 'received' // a lifecycle event for this device: { seq, kind, by?, text? }
  | 'worktree' // created from { base }
  | 'setup_started' | 'setup_ok' // { hash }
  | 'session' // { session_id }
  | 'ended' // { session_id, reason }
  | 'stopped' // { reason }: interrupted; the human resumes it
  | 'committed' // { sha } or { sha: null } (nothing to commit)
  | 'abandoned'
  | 'start_failed' // { reason }
  | (string & {});
export type JournalRecord = { state: JournalState; at: string; [k: string]: unknown };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export class Journal {
  root: string;
  quarantine: string;
  constructor(home: Home, epoch: string) {
    if (!ID.test(epoch)) throw new Error(`malformed coordinator epoch ${epoch}`);
    this.root = path.join(home.root, 'journal', epoch);
    this.quarantine = path.join(home.root, 'quarantine');
  }

  file(projectId: string, taskId: string): string {
    if (!ID.test(projectId) || !TASK_ID.test(taskId)) throw new Error(`invalid journal key ${projectId}/${taskId}`);
    return path.join(this.root, projectId, `${taskId}.jsonl`);
  }

  /** Appends one record and fsyncs it before returning: the step is durable before its side effect. */
  append(projectId: string, taskId: string, state: JournalState, data: Record<string, unknown> = {}): JournalRecord {
    const rec: JournalRecord = { state, at: new Date().toISOString(), ...data };
    const file = this.file(projectId, taskId);
    ensureDir(path.dirname(file));
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return rec;
  }

  read(projectId: string, taskId: string): JournalRecord[] {
    const file = this.file(projectId, taskId);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const lines = text.split('\n');
    const out: JournalRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as JournalRecord);
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        if (i === lines.length - 1) break; // a torn last line: the crash came mid-write
        this.toQuarantine(file);
        return [];
      }
    }
    return out;
  }

  /** The latest record of `state`, if any. */
  last(projectId: string, taskId: string, state?: JournalState): JournalRecord | null {
    const recs = this.read(projectId, taskId);
    for (let i = recs.length - 1; i >= 0; i--) if (!state || recs[i]!.state === state) return recs[i]!;
    return null;
  }

  has(projectId: string, taskId: string, state: JournalState): boolean {
    return this.last(projectId, taskId, state) !== null;
  }

  /** Every journaled task: [projectId, taskId]. */
  tasks(): [string, string][] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter((p) => ID.test(p)).flatMap((p) =>
      fs.readdirSync(path.join(this.root, p)).filter((f) => f.endsWith('.jsonl')).map((f) => [p, f.slice(0, -'.jsonl'.length)] as [string, string]));
  }

  toQuarantine(file: string): void {
    ensureDir(this.quarantine);
    fs.renameSync(file, path.join(this.quarantine, `${path.basename(file)}.${Date.now()}`));
  }
}
