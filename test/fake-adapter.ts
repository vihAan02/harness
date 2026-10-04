// A stand-in AgentAdapter for harnessd tests that need to control agent turns exactly (sync at turn end,
// the hold, conflicts, lands). No vendor CLI runs: the test decides when a turn starts and ends and what the
// agent "read" or "edited", and the adapter records every injection and hold. The real ClaudeAdapter is
// covered by the adapter and S3 tests; this one isolates harnessd's own ordering rules.
import { AsyncQueue } from '../packages/adapters/src/queue.ts';
import type {
  AgentAdapter, Capabilities, DeliveryReceipt, EnvelopedMessage, Observation, ObservedRead, SessionHandle, SessionSpec, SessionStatus,
} from '../packages/adapters/src/adapter.ts';

/** `notice`: attached after a tool batch (D-99); `stop`: delivered by the Stop gate (D-100); otherwise injected as a message. */
export type Injection = { id: string; text: string; hold: string | null; status: SessionStatus; at: number; via?: 'notice' | 'stop' };
type Queued = { msg: EnvelopedMessage; resolve: (r: DeliveryReceipt) => void; reject: (e: Error) => void };

export class FakeSession implements SessionHandle {
  id: string;
  pid: number | null = null;
  vendorSessionId: string | null = null;
  status: SessionStatus = 'idle';
  hold: string | null = null;
  holds: (string | null)[] = [];
  injected: Injection[] = [];
  notices: Queued[] = [];
  out = new AsyncQueue<Observation>();
  spec: SessionSpec;
  private calls = 0;
  constructor(spec: SessionSpec) {
    this.id = spec.sessionId;
    this.spec = spec;
  }
  emit(o: Observation): void { this.out.push(o); }
  startTurn(): void { this.status = 'working'; this.emit({ kind: 'status', status: 'working' }); }
  /**
   * Turn end, as with the real adapter. While the task is in progress, the Stop gate delivers the notices no
   * tool batch took, and the turn then ends (D-100; the fake has no cap). Once it isn't, they fail undelivered.
   * Any left over would open the next turn at once, with no idle in between (D-99).
   */
  endTurn(): void {
    const open = this.spec.taskOpen?.() !== false;
    if (this.spec.turnEndPending?.()) {
      // harnessd syncs at this turn end: the notices wait for its next message (D-100).
      if (!open) for (const n of this.notices.splice(0)) n.reject(new Error('not delivered: the task is no longer in progress'));
      this.status = 'idle';
      this.emit({ kind: 'turn.ended', reason: 'completed', isError: false, denied: 0, deniedIds: [] });
      this.emit({ kind: 'status', status: 'idle' });
      return;
    }
    for (const n of this.notices.splice(0)) {
      if (!open) { n.reject(new Error('not delivered: the task is no longer in progress')); continue; }
      this.injected.push({ id: n.msg.id, text: n.msg.text, hold: this.hold, status: this.status, at: Date.now(), via: 'stop' });
      n.resolve({ messageId: n.msg.id, landed: 'stop_hook', deliveredAt: Date.now() });
    }
    const next = this.notices.length > 0;
    if (!next) this.status = 'idle';
    this.emit({ kind: 'turn.ended', reason: 'completed', isError: false, denied: 0, deniedIds: [] });
    if (next) return this.flushNotices(true);
    this.emit({ kind: 'status', status: 'idle' });
  }
  /** Queued notices go out as messages: at turn end, or ahead of a message injected after them. */
  flushNotices(atTurnEnd: boolean): void {
    for (const n of this.notices.splice(0)) n.resolve(this.inject(n.msg, atTurnEnd ? 'idle' : this.status));
  }
  /** A batch of tool calls finished: the queued notices are attached to its results. */
  toolBatch(): void {
    for (const n of this.notices.splice(0)) {
      this.injected.push({ id: n.msg.id, text: n.msg.text, hold: this.hold, status: this.status, at: Date.now(), via: 'notice' });
      n.resolve({ messageId: n.msg.id, landed: 'between_tools', deliveredAt: Date.now() });
    }
  }
  inject(msg: EnvelopedMessage, status: SessionStatus = this.status): DeliveryReceipt {
    this.injected.push({ id: msg.id, text: msg.text, hold: this.hold, status, at: Date.now() });
    return { messageId: msg.id, landed: status === 'working' ? 'between_tools' : 'new_turn', deliveredAt: Date.now() };
  }
  /** A tool call the hooks saw, with what it read. */
  read(paths: string[]): void {
    const id = `toolu_fake_${++this.calls}`;
    this.emit({ kind: 'tool.called', toolUseId: id, tool: 'Read', category: 'read', paths });
    this.emit({ kind: 'hook.seen', toolUseId: id, tool: 'Read', event: 'post' });
    this.emit({ kind: 'read.observed', toolUseId: id, reads: paths.map((path): ObservedRead => ({ path, source: 'read_tool', confidence: 'high' })), outside: [] });
    this.emit({ kind: 'tool.result', toolUseId: id, isError: false });
  }
  edited(paths: string[]): void { this.emit({ kind: 'edit.observed', paths, outside: [] }); }
}

const CAPS: Capabilities = {
  canCaptureReads: true, canDenyToolCalls: true, canInjectTurn: true, canResume: false, supportsMCP: true, supportsHooks: true,
  readCaptureFidelity: 'tool-observed', canInjectBetweenTools: true, canSandboxReads: false,
  hooksFailClosed: { preToolUse: true, postToolUse: false, stop: false }, authModes: ['api-key'],
};

export class FakeAdapter implements AgentAdapter {
  readonly vendor = 'claude';
  sessions: FakeSession[] = [];
  version() { return { pinned: 'fake', installed: 'fake' }; }
  capabilities(): Capabilities { return CAPS; }
  async startSession(spec: SessionSpec, first: EnvelopedMessage): Promise<FakeSession> {
    const s = new FakeSession(spec);
    this.sessions.push(s);
    s.emit({ kind: 'session.init', vendorSessionId: spec.sessionId, vendorVersion: 'fake', model: spec.model?.id ?? 'fake-model' });
    s.emit({ kind: 'status', status: 'idle' });
    void this.injectMessage(s, first);
    return s;
  }
  resumeSession(): Promise<SessionHandle> { throw new Error('not supported'); }
  injectMessage(h: SessionHandle, msg: EnvelopedMessage): Promise<DeliveryReceipt> {
    const s = h as FakeSession;
    if (s.status === 'ended') return Promise.reject(new Error('ended'));
    s.flushNotices(false);
    return Promise.resolve(s.inject(msg));
  }
  queueNotice(h: SessionHandle, msg: EnvelopedMessage): Promise<DeliveryReceipt> {
    const s = h as FakeSession;
    if (s.status !== 'working') return this.injectMessage(h, msg);
    return new Promise((resolve, reject) => { s.notices.push({ msg, resolve, reject }); });
  }
  withdrawNotice(h: SessionHandle, messageId: string): boolean {
    const s = h as FakeSession;
    const i = s.notices.findIndex((n) => n.msg.id === messageId);
    if (i < 0) return false;
    s.notices.splice(i, 1)[0]!.reject(new Error('withdrawn'));
    return true;
  }
  async stopSession(h: SessionHandle): Promise<void> {
    const s = h as FakeSession;
    if (s.status === 'ended') return;
    s.status = 'ended';
    for (const n of s.notices.splice(0)) n.reject(new Error('ended'));
    s.emit({ kind: 'ended', reason: 'stopped' });
    s.out.end();
  }
  getStatus(h: SessionHandle): SessionStatus { return (h as FakeSession).status; }
  setHold(h: SessionHandle, reason: string | null): void {
    const s = h as FakeSession;
    s.hold = reason;
    s.holds.push(reason);
  }
  compilePermissions(): unknown { return {}; }
  setupHooks(): unknown { return {}; }
  observations(h: SessionHandle): AsyncIterable<Observation> { return (h as FakeSession).out; }
  /** The session running `taskId` (by worktree path). */
  of(taskId: string): FakeSession {
    const s = [...this.sessions].reverse().find((x) => x.spec.worktree.endsWith(`/${taskId}`));
    if (!s) throw new Error(`no fake session for ${taskId}`);
    return s;
  }
}
