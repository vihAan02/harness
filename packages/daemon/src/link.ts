import type { AgentEvent, ClientOpInput, ErrorCode, RoomEvent } from "@mp/protocol";
import type { RoomMirror } from "@mp/room";

/** An op as a caller writes it; the link assigns `reqId`. */
export type OpRequest = ClientOpInput extends infer T ? (T extends unknown ? Omit<T, "reqId"> : never) : never;

export class OfflineError extends Error {
  constructor(message = "not connected to the room") {
    super(message);
  }
}

export class OpFailedError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface LinkEvents {
  event: (event: RoomEvent) => void;
  stream: (agentId: string, events: AgentEvent[]) => void;
  /** Fired with true after every successful (re)connect, and false on disconnect. */
  status: (connected: boolean) => void;
  /** The relay refused us for good (e.g. wrong secret). The link stops retrying. */
  fatal: (message: string) => void;
}

/** A connection to one room. The real one is RelayClient; tests use LoopbackLink. */
export interface RoomLink {
  readonly roomId: string;
  readonly mirror: RoomMirror;
  readonly connected: boolean;
  start(): void;
  /** Resolves with the op's result. Throws OfflineError when disconnected, OpFailedError when rejected. */
  request(op: OpRequest): Promise<unknown>;
  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): () => void;
  close(): void;
}

/** Tiny typed emitter shared by link implementations. */
type AnyHandler = (...args: unknown[]) => void;

export class Emitter {
  private readonly handlers = new Map<keyof LinkEvents, Set<AnyHandler>>();

  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    const h = fn as unknown as AnyHandler;
    set.add(h);
    return () => set!.delete(h);
  }

  emit<K extends keyof LinkEvents>(event: K, ...args: Parameters<LinkEvents[K]>): void {
    for (const fn of this.handlers.get(event) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[mp] ${String(event)} handler failed`, err);
      }
    }
  }
}
