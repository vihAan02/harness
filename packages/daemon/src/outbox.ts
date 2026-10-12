// harnessd's durable outbox (D-113): the reports that must reach the coordinator survive a restart.
// - Each one is written and fsynced before it's sent, and removed once the server answers it.
// - After a reconnect or a restart they're sent again, in the order they were made, with the same command_id:
//   the server runs a command once per command_id (D-74), so a resend never acts twice.
// - One the server refused moves to dead/, with its error, for the human to see (the UI's health).
// - Files: ~/.harness/outbox/<n>-<command_id>.json, n increasing. A file that can't be read (a crash mid-write
//   before the rename) is moved to dead/ too: never a crash loop.
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from '@harness/protocol';
import { ensureDir } from './home.ts';

export type OutboxEntry = { n: number; at: string; msg: Command };
export type DeadEntry = { name: string; command_id: string; error: string; at: string };
const FILE = /^(\d{12})-([A-Za-z0-9_-]{1,64})\.json$/;

/** Writes `value` to `file` as JSON and fsyncs the file and its directory before returning. */
function writeDurable(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export class Outbox {
  dir: string;
  deadDir: string;
  next = 1;
  files = new Map<string, string>(); // command_id → file name

  constructor(dir: string) {
    this.dir = dir;
    this.deadDir = path.join(dir, 'dead');
    ensureDir(this.dir);
  }

  /** What's waiting, oldest first. Unreadable files go to dead/. */
  load(): OutboxEntry[] {
    const entries: OutboxEntry[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (name.endsWith('.tmp')) { fs.rmSync(path.join(this.dir, name), { force: true }); continue; } // never renamed: never sent
      const m = FILE.exec(name);
      if (!m) continue;
      try {
        const e = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as OutboxEntry;
        if (e.msg?.command_id !== m[2] || e.n !== Number(m[1])) throw new Error('entry does not match its file name');
        entries.push(e);
        this.files.set(e.msg.command_id, name);
      } catch (err) {
        this.moveToDead(name, { name: '?', command_id: m[2]!, error: `unreadable: ${(err as Error).message}`, at: new Date().toISOString() });
      }
      this.next = Math.max(this.next, Number(m[1]) + 1);
    }
    return entries.sort((a, b) => a.n - b.n);
  }

  /** Records a command before it's sent. */
  put(msg: Command): OutboxEntry {
    const entry: OutboxEntry = { n: this.next++, at: new Date().toISOString(), msg };
    const name = `${String(entry.n).padStart(12, '0')}-${msg.command_id}.json`;
    writeDurable(path.join(this.dir, name), entry);
    this.files.set(msg.command_id, name);
    return entry;
  }

  /** The server answered it: it's done. */
  remove(commandId: string): void {
    const name = this.files.get(commandId);
    if (!name) return;
    this.files.delete(commandId);
    fs.rmSync(path.join(this.dir, name), { force: true });
  }

  /** The server refused it: kept in dead/, with why, for the human. */
  bury(commandId: string, name: string, error: string): void {
    const file = this.files.get(commandId);
    if (!file) return;
    this.files.delete(commandId);
    this.moveToDead(file, { name, command_id: commandId, error, at: new Date().toISOString() });
  }

  pending(): number {
    return this.files.size;
  }

  dead(): DeadEntry[] {
    if (!fs.existsSync(this.deadDir)) return [];
    return fs.readdirSync(this.deadDir).filter((f) => f.endsWith('.why.json')).sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.deadDir, f), 'utf8')) as DeadEntry);
  }

  moveToDead(file: string, why: DeadEntry): void {
    ensureDir(this.deadDir);
    fs.renameSync(path.join(this.dir, file), path.join(this.deadDir, file));
    writeDurable(path.join(this.deadDir, file.replace(/\.json$/, '.why.json')), why);
  }
}
