// This device's model spend and its provider circuit (D-116). Both are local files, so a restart remembers them.
// - The spend ledger: each session's highest reported cost, by UTC day (~/.harness/spend/<day>.json). The day's total
//   is what this device spent, whichever project. A session's cap is the smaller of its own cap and what's left of
//   the day; no session starts with less than MIN_START_USD left.
// - The circuit: an auth or billing error from the provider stops every agent on this device and keeps new ones from
//   starting until the human resets it; the day's budget running out does the same until the next UTC day. A rate
//   limit stops only the session that hit it, after repeated retries. Nothing switches provider (D-116).
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic, type Home } from './home.ts';

/** Below this, a session would barely finish its first request: harnessd doesn't start one. */
export const MIN_START_USD = 0.03;
/** Rate-limit errors in one session before harnessd stops it (the CLI retries each one itself, F-65). */
export const RATE_LIMIT_STOP = 3;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export class SpendLedger {
  dir: string;
  constructor(home: Home) {
    this.dir = path.join(home.root, 'spend');
  }

  file(day: string): string {
    if (!DAY.test(day)) throw new Error(`malformed day ${day}`);
    return path.join(this.dir, `${day}.json`);
  }

  /** Records a session's running cost (the vendor reports running totals): its highest value counts. */
  record(sessionId: string, costUsd: number, now = Date.now()): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    const f = this.file(utcDay(now));
    const all = readJson<Record<string, number>>(f, {});
    if ((all[sessionId] ?? 0) >= costUsd) return;
    ensureDir(this.dir);
    writeJsonAtomic(f, { ...all, [sessionId]: costUsd });
  }

  spent(now = Date.now()): number {
    return Object.values(readJson<Record<string, number>>(this.file(utcDay(now)), {})).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  }

  /** What's left of the day, or null with no daily budget. */
  remaining(daily: number | null, now = Date.now()): number | null {
    return daily === null ? null : Math.max(0, daily - this.spent(now));
  }
}

export type CircuitKind = 'auth' | 'billing' | 'budget';
export type CircuitState = { kind: CircuitKind; reason: string; at: string; day: string };

export class ProviderCircuit {
  file: string;
  constructor(home: Home) {
    this.file = path.join(home.root, 'provider-circuit.json');
  }

  /** Open, and why; a budget circuit closes by itself on the next UTC day. */
  state(now = Date.now()): CircuitState | null {
    const s = readJson<CircuitState | null>(this.file, null);
    if (!s) return null;
    if (s.kind === 'budget' && s.day !== utcDay(now)) {
      this.reset();
      return null;
    }
    return s;
  }

  open(kind: CircuitKind, reason: string, now = Date.now()): void {
    if (this.state(now)) return; // the first reason stands
    writeJsonAtomic(this.file, { kind, reason: reason.slice(0, 300), at: new Date(now).toISOString(), day: utcDay(now) });
  }

  reset(): void {
    fs.rmSync(this.file, { force: true });
  }
}
