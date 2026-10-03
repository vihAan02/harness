// A stand-in AgentAdapter for harnessd tests that need to control agent turns exactly (sync at turn end,
// the hold, conflicts, lands). No vendor CLI runs: the test decides when a turn starts and ends and what the
// agent "read" or "edited", and the adapter records every injection and hold. The real ClaudeAdapter is
// covered by the adapter and S3 tests; this one isolates harnessd's own ordering rules.
import { AsyncQueue } from '../packages/adapters/src/queue.ts';
import type {
  AgentAdapter, Capabilities, DeliveryReceipt, EnvelopedMessage, Observation, ObservedRead, SessionHandle, SessionSpec, SessionStatus,
} from '../packages/adapters/src/adapter.ts';

export type Injection = { id: string; text: string; hold: string | null; status: SessionStatus; at: number };

export class FakeSession implements SessionHandle {
  id: string;
  pid: number | null = null;
  vendorSessionId: string | null = null;
  status: SessionStatus = 'idle';
  hold: string | null = null;
  holds: (string | null)[] = [];
  injected: Injection[] = [];
  out = new AsyncQueue<Observation>();
  spec: SessionSpec;
  private calls = 0;
  constructor(spec: SessionSpec) {
    this.id = spec.sessionId;
    this.spec = spec;
  }
  emit(o: Observation): void { this.out.push(o); }
  startTurn(): void { this.status = 'working'; this.emit({ kind: 'status', status: 'working' }); }
  endTurn(): void {
    this.status = 'idle';
    this.emit({ kind: 'turn.ended', reason: 'completed', isError: false, denied: 0, deniedIds: [] });
    this.emit({ kind: 'status', status: 'idle' });
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
    s.injected.push({ id: msg.id, text: msg.text, hold: s.hold, status: s.status, at: Date.now() });
    const landed = s.status === 'working' ? 'between_tools' : 'new_turn';
    return Promise.resolve({ messageId: msg.id, landed, deliveredAt: Date.now() });
  }
  async stopSession(h: SessionHandle): Promise<void> {
    const s = h as FakeSession;
    if (s.status === 'ended') return;
    s.status = 'ended';
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
