// The CLI's connection to the coordination server (protocol.md §2). One short-lived WebSocket per
// command: hello (the local token, or this device's key, D-111), replay the project's log into a view,
// then send commands.
import { randomUUID, type KeyObject } from 'node:crypto';
import { Handshake, ProjectView, serverFrame, ServerIdentityError, untrustedText, type LocalConfig } from '@harness/daemon';
import { PROTOCOL_VERSION, type EventMessage, type ServerMessage } from '@harness/protocol';

export class CliError extends Error {}

export class CliClient {
  ws: WebSocket;
  view: ProjectView;
  projectId: string;
  results = new Map<string, (m: Extract<ServerMessage, { type: 'command_result' }>) => void>();
  onEvent: ((e: EventMessage) => void) | null = null;
  closed: Promise<void>;

  constructor(ws: WebSocket, projectId: string) {
    this.ws = ws;
    this.projectId = projectId;
    this.view = new ProjectView(projectId);
    this.closed = new Promise((r) => ws.addEventListener('close', () => r()));
  }

  /** Connects, and resolves once the project's log has been replayed up to its current head. */
  static async connect(config: LocalConfig, projectId: string, timeoutMs = 10_000, deviceKey: KeyObject | null = null): Promise<CliClient> {
    let hs: Handshake;
    try { hs = new Handshake({ config, deviceKey, clientKind: 'cli', subscribe: [{ project_id: projectId, after_seq: 0 }] }); } catch (e) { throw new CliError((e as Error).message); }
    const ws = new WebSocket(config.serverUrl);
    const c = new CliClient(ws, projectId);
    await new Promise<void>((resolve, reject) => {
      let unverified = ''; // what an unverified answer said, for the timeout's message
      const timer = setTimeout(() => reject(new CliError(`no ${hs.deviceKeyAuth ? 'verified ' : ''}answer from the coordination server at ${config.serverUrl}${unverified}`)), timeoutMs);
      let head = -1;
      const done = () => { clearTimeout(timer); resolve(); };
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new CliError(`can't reach the coordination server at ${config.serverUrl}; is it running (npm run server)?`)); });
      ws.addEventListener('open', () => ws.send(JSON.stringify(hs.hello())));
      let verified = !hs.deviceKeyAuth;
      ws.addEventListener('message', (ev) => {
        const m = serverFrame(ev.data);
        if (!m) return;
        if (!verified) {
          // With device keys, nothing is trusted until the server proves its pinned key (D-111), and nothing it sends
          // before that can crash the CLI: any failure is a CliError.
          if (m.type === 'error') unverified = ` (an unverified answer said ${untrustedText(m.code, 40)}: ${untrustedText(m.message)})`;
          if (m.type !== 'challenge') return;
          try {
            ws.send(JSON.stringify(hs.answer(m)));
            verified = true;
          } catch (e) {
            clearTimeout(timer);
            ws.close();
            reject(new CliError(e instanceof ServerIdentityError ? e.message : `the server's challenge couldn't be checked: ${untrustedText((e as Error)?.message)}`));
          }
          return;
        }
        if (m.type === 'welcome') {
          head = m.projects.find((p) => p.project_id === projectId)?.head_seq ?? 0;
          if (head === 0) done();
        } else if (m.type === 'event') {
          c.view.apply(m);
          c.onEvent?.(m);
          if (head >= 0 && m.seq >= head) done();
        } else if (m.type === 'command_result') {
          c.results.get(m.command_id)?.(m);
        } else if (m.type === 'error') {
          clearTimeout(timer);
          reject(new CliError(`server: ${m.code}: ${m.message}`));
        }
      });
    });
    return c;
  }

  async command(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const command_id = randomUUID();
    const result = new Promise<Extract<ServerMessage, { type: 'command_result' }>>((r) => this.results.set(command_id, r));
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'command', command_id, project_id: this.projectId, name, args }));
    const r = await result;
    this.results.delete(command_id);
    if (!r.ok) throw new CliError(`${r.error.code}: ${r.error.message}`);
    return (r.result ?? {}) as Record<string, unknown>;
  }

  close(): void {
    this.ws.close();
  }
}
