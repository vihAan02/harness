// A minimal protocol client for tests, on Node's built-in WebSocket.
import type { ServerMessage } from '@harness/protocol';

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;
type Waiter = { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; timer: NodeJS.Timeout };

export class TestClient {
  ws: WebSocket;
  inbox: ServerMessage[] = [];
  waiters: Waiter[] = [];
  closed: Promise<number>;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      const i = this.waiters.findIndex((w) => w.match(m));
      if (i < 0) { this.inbox.push(m); return; }
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w!.timer);
      w!.resolve(m);
    });
    this.closed = new Promise((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
  }

  static async open(url: string): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new TestClient(ws);
  }

  send(m: unknown) { this.ws.send(JSON.stringify(m)); }

  /** The next message of `type` (matching `pred`), from what arrived already or what arrives within `ms`. */
  next<T extends ServerMessage['type']>(type: T, pred: (m: Of<T>) => boolean = () => true, ms = 3000): Promise<Of<T>> {
    const match = (m: ServerMessage) => m.type === type && pred(m as Of<T>);
    const i = this.inbox.findIndex(match);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as Of<T>);
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        match, resolve: resolve as (m: ServerMessage) => void,
        timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`timed out waiting for ${type}`)); }, ms),
      };
      this.waiters.push(w);
    });
  }

  /** Every message of `type` received so far and not yet taken. */
  take<T extends ServerMessage['type']>(type: T): Of<T>[] {
    const out = this.inbox.filter((m) => m.type === type) as Of<T>[];
    this.inbox = this.inbox.filter((m) => m.type !== type);
    return out;
  }

  close() { this.ws.close(); }
}
