// Agent process tracking (D-62). Each agent session's child PID and process start time are recorded
// under ~/.harness/sessions. If harnessd dies mid-turn, the vendor process keeps working
// unsupervised (SP-10). So on start, harnessd kills every recorded process that is still running
// with the same start time. Matching the start time means a PID the OS has since reused for
// something else is never killed. Then it reconciles the task's edits from the worktree (D-70).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { changedPaths } from './git.ts';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';

const run = promisify(execFile);

export type SessionRecord = {
  sessionId: string; agentId: string; taskId: string; projectId: string; worktree: string; baseBranch: string;
  pid: number | null; pidStart: string | null; configDir: string; startedAt: string;
  vendor?: string; vendorSessionId?: string; // with configDir and worktree, the resume key (D-65, SP-07)
  endedAt?: string; endReason?: string;
};
export type OrphanReport = { sessionId: string; taskId: string; projectId: string; pid: number; changedPaths: string[] };

/** The process's start time as `ps` reports it, or null if no such process is running. */
export async function processStart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' } });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export class Sessions {
  dir: string;
  constructor(home: Home) {
    this.dir = home.sessions;
  }
  file(id: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`invalid session id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }
  save(r: SessionRecord): void {
    writeJsonAtomic(this.file(r.sessionId), r);
  }
  /** A session recovery found ended (D-113): its record says so, so it's never supervised again. */
  markEnded(id: string, reason: string): void {
    const r = readJson<SessionRecord | null>(this.file(id), null);
    if (r && !r.endedAt) this.save({ ...r, pid: null, endedAt: new Date().toISOString(), endReason: reason });
  }
  list(): SessionRecord[] {
    ensureDir(this.dir);
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'))
      .map((f) => readJson<SessionRecord | null>(path.join(this.dir, f), null)).filter((r): r is SessionRecord => r !== null);
  }
}

async function waitGone(pid: number, start: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await processStart(pid)) !== start) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Kills orphans from a previous run and returns what each one's task had changed. */
export async function killOrphans(sessions: Sessions): Promise<OrphanReport[]> {
  const reports: OrphanReport[] = [];
  for (const rec of sessions.list()) {
    if (rec.pid === null || !rec.pidStart || rec.endedAt) continue;
    const start = await processStart(rec.pid);
    if (start === rec.pidStart) {
      try { process.kill(rec.pid, 'SIGTERM'); } catch {}
      if (!(await waitGone(rec.pid, start, 3000))) {
        try { process.kill(rec.pid, 'SIGKILL'); } catch {}
        await waitGone(rec.pid, start, 2000);
      }
      const paths = fs.existsSync(rec.worktree) ? await changedPaths(rec.worktree, rec.baseBranch).catch(() => []) : [];
      reports.push({ sessionId: rec.sessionId, taskId: rec.taskId, projectId: rec.projectId, pid: rec.pid, changedPaths: paths });
      sessions.save({ ...rec, pid: null, endedAt: new Date().toISOString(), endReason: 'orphan killed by harnessd on start' });
    } else {
      sessions.save({ ...rec, pid: null, endedAt: new Date().toISOString(), endReason: 'process gone when harnessd started' });
    }
  }
  return reports;
}
