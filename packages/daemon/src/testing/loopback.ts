import { ClientOp, type AgentEvent, type RoomEvent } from "@mp/protocol";
import { RoomEngine, RoomMirror, type EngineOptions } from "@mp/room";
import { Emitter, OfflineError, OpFailedError, type LinkEvents, type OpRequest, type RoomLink } from "../link.ts";

/**
 * An in-process stand-in for the relay: one RoomEngine shared by several LoopbackLinks.
 * Delivery is synchronous, which makes multi-daemon scenarios deterministic in tests.
 */
export class LoopbackRelay {
  readonly engine: RoomEngine;
  private readonly links = new Set<LoopbackLink>();
  now: () => number;

  constructor(roomId = "000000000000000000000001", opts: Partial<EngineOptions> & { now?: () => number } = {}) {
    const { now, ...engineOpts } = opts;
    this.engine = new RoomEngine(roomId, engineOpts);
    this.now = now ?? Date.now;
  }

  link(member: { id: string; name: string }): LoopbackLink {
    const link = new LoopbackLink(this, member);
    this.links.add(link);
    return link;
  }

  /** @internal */
  deliver(events: RoomEvent[], stream: { agentId: string; events: AgentEvent[] } | undefined, from: LoopbackLink | null) {
    for (const link of this.links) link.receive(events, stream && link !== from ? stream : undefined);
  }

  /** Runs the engine's timers (offline agents, lock expiry) at `now`. */
  tick(now = this.now()): void {
    this.deliver(this.engine.tick(now).events, undefined, null);
  }
}

export class LoopbackLink implements RoomLink {
  readonly roomId: string;
  readonly mirror: RoomMirror;
  private readonly relay: LoopbackRelay;
  private readonly member: { id: string; name: string };
  private readonly emitter = new Emitter();
  private online = false;
  private req = 0;

  constructor(relay: LoopbackRelay, member: { id: string; name: string }) {
    this.relay = relay;
    this.member = member;
    this.roomId = relay.engine.state.roomId;
    this.mirror = new RoomMirror(this.roomId);
  }

  get connected(): boolean {
    return this.online;
  }

  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): () => void {
    return this.emitter.on(event, fn);
  }

  start(): void {
    this.setOnline(true);
  }

  close(): void {
    this.setOnline(false);
  }

  /** Simulates the network dropping (false) and coming back (true). */
  setOnline(online: boolean): void {
    if (online === this.online) return;
    if (online) {
      const res = this.relay.engine.connect(this.member, this.relay.now());
      this.mirror.reset(this.relay.engine.snapshot());
      this.online = true;
      this.relay.deliver(res.events, undefined, this);
      this.emitter.emit("status", true);
    } else {
      this.online = false;
      const res = this.relay.engine.disconnect(this.member.id, this.relay.now());
      this.relay.deliver(res.events, undefined, this);
      this.emitter.emit("status", false);
    }
  }

  async request(op: OpRequest): Promise<unknown> {
    if (!this.online) throw new OfflineError();
    const parsed = ClientOp.parse({ ...op, reqId: `l${++this.req}` });
    const res = this.relay.engine.apply({ memberId: this.member.id, now: this.relay.now() }, parsed);
    if (!res.ok) throw new OpFailedError(res.error!.code, res.error!.message);
    this.relay.deliver(res.events, res.stream, this);
    return res.result;
  }

  /** @internal */
  receive(events: RoomEvent[], stream?: { agentId: string; events: AgentEvent[] }): void {
    if (!this.online) return;
    for (const e of events) {
      this.mirror.apply(e);
      this.emitter.emit("event", e);
    }
    if (stream) {
      this.mirror.applyStream(stream.agentId, stream.events);
      this.emitter.emit("stream", stream.agentId, stream.events);
    }
  }
}
