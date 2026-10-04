// The A/B run recorder (B9a; validation.md §4): one timeline and one log per run, on the same clock in both
// arms. The harness arm also has its event log; the baseline arm (B9b) has only this, so anything both arms
// must measure the same way (M1's start and end, the cap) is marked here.
import fs from 'node:fs';
import path from 'node:path';

export class Recorder {
  dir: string;
  t0 = Date.now();

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Milliseconds since the run started. */
  ms(): number {
    return Date.now() - this.t0;
  }

  /** One timeline entry: what happened, when (run clock and wall clock), and any detail. */
  mark(what: string, detail: Record<string, unknown> = {}): void {
    fs.appendFileSync(path.join(this.dir, 'timeline.jsonl'), `${JSON.stringify({ t_ms: this.ms(), at: new Date().toISOString(), what, ...detail })}\n`);
  }

  /** One log line, prefixed with the run clock. Also echoed to stdout. */
  log(line: string): void {
    const text = `[${(this.ms() / 1000).toFixed(1).padStart(6)}s] ${line}`;
    fs.appendFileSync(path.join(this.dir, 'run.log'), `${text}\n`);
    console.log(text);
  }

  writeJson(name: string, value: unknown): void {
    fs.writeFileSync(path.join(this.dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }

  writeLines(name: string, values: unknown[]): void {
    fs.writeFileSync(path.join(this.dir, name), values.map((v) => JSON.stringify(v)).join('\n') + (values.length ? '\n' : ''));
  }
}
