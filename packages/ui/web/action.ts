// One human click (D-117; protocol.md §12): sent once, and never shown as done on the click alone. The action is
// pending until a snapshot with `head_seq` at or past the seqs the coordinator appended arrives. A retry reuses the
// command_id, so the coordinator applies it once (§12, "Pending until confirmed").
import type { ProjectSnapshot } from '@harness/protocol';
import { ApiError } from './api.ts';

export type ActionStatus = 'idle' | 'sending' | 'sent' | 'confirmed' | 'failed' | 'conflict';

function largestSeq(answer: unknown): number | null {
  if (answer === null || typeof answer !== 'object') return null;
  const seqs = (answer as { seqs?: unknown }).seqs;
  if (!Array.isArray(seqs)) return null;
  let max: number | null = null;
  for (const s of seqs) if (typeof s === 'number' && (max === null || s > max)) max = s;
  return max;
}

export class Action {
  /** Generated once and reused by a retry, so a repeated click stays idempotent. */
  readonly commandId: string;
  status: ActionStatus = 'idle';
  message = '';
  private run: (commandId: string) => Promise<unknown>;
  /** The largest seq the answer appended; the action is confirmed once head_seq reaches it. */
  private maxSeq: number | null = null;

  constructor(run: (commandId: string) => Promise<unknown>) {
    this.run = run;
    this.commandId = crypto.randomUUID();
  }

  /** From idle or failed only; anything else is a no-op. */
  async send(): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'failed') return;
    this.status = 'sending';
    this.message = '';
    try {
      const answer = await this.run(this.commandId);
      const seq = largestSeq(answer);
      if (seq === null) {
        this.status = 'confirmed'; // nothing to wait for
      } else {
        this.maxSeq = seq;
        this.status = 'sent';
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        this.status = 'conflict';
        this.message = e.message;
      } else {
        this.status = 'failed';
        this.message = e instanceof Error ? e.message : String(e);
      }
    }
  }

  /** A sent action becomes confirmed once the snapshot is at or past its seqs. True if it changed. */
  observe(snap: ProjectSnapshot | null): boolean {
    if (this.status !== 'sent' || this.maxSeq === null || snap === null) return false;
    if (snap.head_seq >= this.maxSeq) {
      this.status = 'confirmed';
      return true;
    }
    return false;
  }

  label(): string {
    switch (this.status) {
      case 'idle': return '';
      case 'sending': return 'Sending…';
      case 'sent': return 'Sent; waiting for harnessd to confirm';
      case 'confirmed': return 'Done';
      case 'failed': return `${this.message} (you can retry)`;
      case 'conflict': return 'This changed since you looked: check it again';
    }
  }

  busy(): boolean {
    return this.status === 'sending' || this.status === 'sent';
  }
}
