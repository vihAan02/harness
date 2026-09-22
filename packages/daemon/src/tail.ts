import { open, stat } from "node:fs/promises";

/**
 * Follows a JSONL file as it grows (Claude Code writes its transcript asynchronously), handing
 * complete lines to `onLines`. Polling keeps it robust to the file not existing yet or being replaced.
 */
export class JsonlTail {
  private readonly path: string;
  private readonly onLines: (lines: string[]) => void;
  private readonly pollMs: number;
  private offset: number;
  private partial = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading = false;

  /** `fromStart: false` skips what's already in the file (e.g. a resumed session's history). */
  constructor(path: string, onLines: (lines: string[]) => void, opts: { fromStart: boolean; pollMs?: number }) {
    this.path = path;
    this.onLines = onLines;
    this.pollMs = opts.pollMs ?? 500;
    this.offset = opts.fromStart ? 0 : -1;
  }

  async start(): Promise<void> {
    if (this.offset === -1) {
      this.offset = await stat(this.path).then((s) => s.size, () => 0);
    }
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    (this.timer as { unref?: () => void }).unref?.();
    await this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads anything appended since the last poll. Safe to call directly (tests, shutdown flushes). */
  async poll(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      let size: number;
      try {
        size = (await stat(this.path)).size;
      } catch {
        return; // not created yet
      }
      if (size < this.offset) {
        // Truncated or replaced: start over.
        this.offset = 0;
        this.partial = "";
      }
      if (size === this.offset) return;
      const fh = await open(this.path, "r");
      try {
        const len = size - this.offset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        this.offset += bytesRead;
        const text = this.partial + buf.subarray(0, bytesRead).toString("utf8");
        const lines = text.split("\n");
        this.partial = lines.pop() ?? "";
        const complete = lines.filter((l) => l.trim());
        if (complete.length) this.onLines(complete);
      } finally {
        await fh.close();
      }
    } finally {
      this.reading = false;
    }
  }
}
