// One harnessd per home (D-113). The lock is a file holding the owner's pid and process start time, created
// atomically with link(2): it's never seen empty or half-written. A lock whose owner is gone (a crash, a SIGKILL)
// is taken over, but only under a second, short-lived guard, so two starting daemons can't both take it over.
// harnessd takes it before anything else at start (before killing orphans), so a second harnessd on the same
// home can never kill the first one's agents.
import fs from 'node:fs';
import path from 'node:path';
import { processStart } from './supervision.ts';

export class LockHeld extends Error {
  pid: number;
  constructor(file: string, pid: number) {
    super(`${file} is held by harnessd pid ${pid}: another harnessd is running on this home`);
    this.pid = pid;
  }
}

type Holder = { pid: number; pidStart: string | null; at: string };

function readHolder(file: string): Holder | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Holder;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (e instanceof SyntaxError) return { pid: 0, pidStart: null, at: '' }; // unreadable: treated as stale
    throw e;
  }
}

/** Whether the holder is a live process: the same pid with the same start time (pids get reused). */
async function alive(h: Holder): Promise<boolean> {
  if (!h.pid) return false;
  const start = await processStart(h.pid).catch(() => null);
  return start !== null && start === h.pidStart;
}

/** Takes the lock, or throws LockHeld. Returns the release function. */
export async function acquireLock(file: string): Promise<() => void> {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const me: Holder = { pid: process.pid, pidStart: await processStart(process.pid), at: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(me), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        fs.linkSync(tmp, file); // atomic, and fails if the lock exists
        return () => {
          const h = readHolder(file);
          if (h?.pid === process.pid) fs.rmSync(file, { force: true });
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const holder = readHolder(file);
      if (holder && await alive(holder)) throw new LockHeld(file, holder.pid);
      // Stale: take it over under a guard, re-checking that it's still the same stale holder.
      const guard = `${file}.takeover`;
      try {
        fs.writeFileSync(guard, String(process.pid), { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Another daemon is taking it over; a guard older than 30 s belongs to one that died mid-takeover.
        if (Date.now() - fs.statSync(guard).mtimeMs > 30_000) fs.rmSync(guard, { force: true });
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      try {
        const again = readHolder(file);
        if (again && again.pid === holder?.pid && again.pidStart === holder?.pidStart) fs.rmSync(file, { force: true });
      } finally {
        fs.rmSync(guard, { force: true });
      }
    }
    throw new Error(`couldn't take ${file}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
