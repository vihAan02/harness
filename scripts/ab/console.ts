// The coordinator's console during an A/B run (validation.md §9; B9b, D-121), the same in both arms. Enter
// starts or stops the M10 timer (coordinating: reading, relaying, deciding, approving, integrating), `note
// <text>` logs a note, `stop` ends the run, and an arm adds its own commands (the baseline's `merge` and
// `sync`). Everything typed lands on the run's timeline; nothing here ever reaches an agent.
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import type { Recorder } from './recorder.ts';

export type ConsoleCommand = { usage: string; run: (args: string) => Promise<string> };

export class CoordinatorConsole {
  rec: Recorder;
  commands: Record<string, ConsoleCommand>;
  /** The run clock when the open M10 interval began, or null. */
  openSince: number | null = null;
  closedMs = 0;
  stopRequested = false;
  private rl: readline.Interface | null = null;
  /** Commands run one at a time, in the order typed. */
  private queue: Promise<void> = Promise.resolve();

  constructor(rec: Recorder, commands: Record<string, ConsoleCommand> = {}) {
    this.rec = rec;
    this.commands = commands;
  }

  /** Reads lines from `input` (the terminal, normally) until close(). */
  start(input: Readable = process.stdin): void {
    this.rl = readline.createInterface({ input, terminal: false });
    this.rl.on('line', (line) => { this.queue = this.queue.then(() => this.handle(line)); });
    this.rec.log(`console: ${this.help()}`);
  }

  help(): string {
    return ['Enter starts/stops the M10 timer', 'note <text>', 'stop', ...Object.entries(this.commands).map(([n, c]) => `${n} ${c.usage}`.trim())].join('; ');
  }

  /** What the M10 timer holds so far, an open interval included. */
  m10Ms(): number {
    return this.closedMs + (this.openSince === null ? 0 : this.rec.ms() - this.openSince);
  }

  toggle(): void {
    const now = this.rec.ms();
    if (this.openSince === null) {
      this.openSince = now;
      this.rec.mark('m10_start');
      this.rec.log('M10 timer: on (coordinating)');
    } else {
      const ms = now - this.openSince;
      this.closedMs += ms;
      this.openSince = null;
      this.rec.mark('m10_stop', { ms });
      this.rec.log(`M10 timer: off (+${(ms / 1000).toFixed(0)} s, ${(this.closedMs / 1000).toFixed(0)} s in all)`);
    }
  }

  async handle(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line) return this.toggle();
    const [name = '', ...rest] = line.split(/\s+/);
    const args = rest.join(' ');
    if (name === 'note') { this.rec.mark('note', { text: args }); this.rec.log(`note: ${args}`); return; }
    if (name === 'stop') { this.stopRequested = true; this.rec.mark('stop_requested'); this.rec.log('stopping the run (the coordinator ended it)'); return; }
    const cmd = this.commands[name];
    if (!cmd) { this.rec.log(`console: unknown command "${name}". ${this.help()}`); return; }
    this.rec.mark('command', { name, args });
    try {
      this.rec.log(`${name}: ${await cmd.run(args)}`);
    } catch (e) {
      this.rec.log(`${name} failed: ${(e as Error).message}`);
    }
  }

  /** Waits for commands already typed, closes an open M10 interval at the end, and stops reading. */
  async close(): Promise<void> {
    await this.queue;
    if (this.openSince !== null) {
      const ms = this.rec.ms() - this.openSince;
      this.closedMs += ms;
      this.openSince = null;
      this.rec.mark('m10_stop', { ms, at_end: true });
    }
    this.rl?.close();
    this.rl = null;
  }
}
