// ClaudeAdapter: Claude Code through the Agent SDK in TypeScript (agent-adapters.md §5).
// One session = one `query()` over a harness-controlled input queue (streaming input, F-02).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentAdapter, DeliveryReceipt, EnvelopedMessage, ErrorKind, HarnessHookSink, Landed, Observation, SessionHandle,
  SessionSpec, SessionStatus, ToolCategory, VendorSessionRef,
} from '../adapter.ts';
import { AsyncQueue } from '../queue.ts';
import { claudeHooks, relativize, type ClaudeHookBundle } from './hooks.ts';
import { AUTH_ENV_VARS, BASE_TOOLS, compileClaudePermissions, SHIM_SERVER, shimToolName, type ClaudePolicyBundle } from './policy.ts';
import { shimServer } from './shim.ts';
import { BUILTIN_SKILLS, claudeCapabilities, installedSdkVersion, PINNED } from './version.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Graceful stop: how long to wait for the CLI to wind down after interrupt() before closing it. */
const GRACE_MS = 5000;

function categoryOf(tool: string): ToolCategory {
  if (tool === 'Read') return 'read';
  if (tool === 'Grep' || tool === 'Glob') return 'search';
  if (tool === 'Edit' || tool === 'NotebookEdit') return 'edit';
  if (tool === 'Write') return 'write';
  if (tool === 'Bash') return 'shell';
  if (tool.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function errorKindOf(code: string | number | null | undefined): ErrorKind {
  if (code === 429 || code === 529 || code === 'rate_limit' || code === 'overloaded') return 'rate_limit';
  if (code === 401 || code === 403 || code === 'authentication_failed') return 'auth';
  if (code === 'billing_error') return 'billing';
  return 'other';
}

/**
 * The hardening D-45, D-46, D-49, D-56 and D-66 promise, checked against what the CLI reports at
 * the start of every turn. Returns the problems found; any problem stops the session.
 */
export function hardeningProblems(init: Record<string, unknown>, spec: Pick<SessionSpec, 'worktree' | 'tools'>): string[] {
  const problems: string[] = [];
  if (init.claude_code_version !== PINNED.cli) problems.push(`Claude Code ${String(init.claude_code_version)} is not the pinned ${PINNED.cli} (D-49)`);
  if (init.apiKeySource !== 'ANTHROPIC_API_KEY') problems.push(`auth came from ${String(init.apiKeySource)}, not the API key (D-56)`);
  if (init.permissionMode !== 'dontAsk') problems.push(`permission mode is ${String(init.permissionMode)}, not dontAsk`);
  if (init.cwd !== spec.worktree) problems.push(`cwd is ${String(init.cwd)}, not the worktree`);
  const allowed = new Set<string>([...BASE_TOOLS, ...spec.tools.map((t) => shimToolName(t.name))]);
  const extra = ((init.tools as string[] | undefined) ?? []).filter((t) => !allowed.has(t));
  if (extra.length) problems.push(`unexpected tools: ${extra.join(', ')} (D-66)`);
  const servers = ((init.mcp_servers as { name: string }[] | undefined) ?? []).map((s) => s.name).filter((n) => n !== SHIM_SERVER);
  if (servers.length) problems.push(`unexpected MCP servers: ${servers.join(', ')} (D-45)`);
  // The two built-in plugins are always present, even with settingSources: [] (SP-06).
  const plugins = ((init.plugins as { name: string; path?: string }[] | undefined) ?? []).filter((p) => p.path !== 'builtin');
  if (plugins.length) problems.push(`plugins loaded: ${plugins.map((p) => p.name).join(', ')} (D-45)`);
  const skills = ((init.skills as string[] | undefined) ?? []).filter((s) => !BUILTIN_SKILLS.has(s));
  if (skills.length) problems.push(`skills from outside the CLI: ${skills.join(', ')} (D-45)`);
  return problems;
}

type PendingDelivery = { messageId: string; pushedAt: number; statusAtPush: SessionStatus; resolve: (r: DeliveryReceipt) => void; reject: (e: Error) => void };

export class ClaudeSession implements SessionHandle {
  id: string;
  pid: number | null = null;
  vendorSessionId: string | null = null;
  status: SessionStatus = 'starting';
  spec: SessionSpec;
  input = new AsyncQueue<SDKUserMessage>();
  out = new AsyncQueue<Observation>();
  pending = new Map<string, PendingDelivery>();
  resultTimes: number[] = [];
  lastResult: Record<string, unknown> | null = null;
  q!: Query;
  done: Promise<void> = Promise.resolve();
  endReason = 'ended';
  /** Settles once the first init is checked: null if the hardening holds, else why it doesn't. Tools wait on it. */
  verdict: Promise<string | null>;
  settleVerdict!: (v: string | null) => void;

  constructor(spec: SessionSpec) {
    this.id = spec.sessionId;
    this.spec = spec;
    this.verdict = new Promise((r) => { this.settleVerdict = r; });
  }

  start(options: Options): void {
    this.q = query({ prompt: this.input, options });
    this.done = this.pump();
  }

  emit(o: Observation): void {
    this.out.push(o);
  }

  setStatus(s: SessionStatus): void {
    if (this.status === s || this.status === 'ended') return;
    this.status = s;
    this.emit({ kind: 'status', status: s });
  }

  /** D-63: always verbatim (no @path expansion, no slash commands); origin is host metadata only. */
  inject(msg: EnvelopedMessage, from?: string): Promise<DeliveryReceipt> {
    if (this.status === 'ended') return Promise.reject(new Error(`session ${this.id} has ended`));
    const uuid = randomUUID();
    const origin = msg.origin === 'human' ? { kind: 'human' as const } : { kind: 'peer' as const, from: from ?? (msg.origin === 'coordinator' ? 'harness' : 'peer') };
    const receipt = new Promise<DeliveryReceipt>((resolve, reject) => {
      this.pending.set(uuid, { messageId: msg.id, pushedAt: Date.now(), statusAtPush: this.status, resolve, reject });
    });
    this.input.push({
      type: 'user', message: { role: 'user', content: msg.text }, parent_tool_use_id: null, uuid,
      origin, client_composed: true, ...(msg.when === 'later' ? { priority: 'later' as const } : {}),
    } as SDKUserMessage);
    return receipt;
  }

  async stop(mode: 'graceful' | 'kill'): Promise<void> {
    if (mode === 'graceful' && this.status !== 'ended') {
      this.endReason = 'stopped';
      try { await this.q.interrupt(); } catch {}
      this.input.end(); // no more input: the CLI exits once the turn winds down
      await Promise.race([this.done, new Promise((r) => setTimeout(r, GRACE_MS))]);
    } else {
      this.endReason = 'killed';
    }
    this.q.close(); // kills the CLI and any in-flight tool (SP-01)
    this.input.end();
    await this.done;
  }

  async pump(): Promise<void> {
    try {
      for await (const m of this.q) this.handle(m as SDKMessage & Record<string, unknown>);
    } catch (e) {
      if (this.endReason === 'ended') {
        this.endReason = 'crashed';
        this.emit({ kind: 'error', error: 'other', message: String((e as Error).message ?? e).slice(0, 500) });
      }
    }
    this.settleVerdict('the session has ended');
    for (const p of this.pending.values()) p.reject(new Error(`session ${this.id} ended before the message was delivered`));
    this.pending.clear();
    this.setStatus('ended');
    this.emit({ kind: 'ended', reason: this.endReason });
    this.out.end();
  }

  handle(m: Record<string, unknown>): void {
    const type = m.type;
    if (type === 'system') this.system(m);
    else if (type === 'assistant') this.assistant(m);
    else if (type === 'result') this.result(m);
    else if (type === 'command_lifecycle') this.lifecycle(m);
  }

  system(m: Record<string, unknown>): void {
    if (m.subtype === 'init') {
      const problems = hardeningProblems(m, this.spec);
      this.settleVerdict(problems.length ? 'the harness could not verify this session\'s hardening' : null);
      if (problems.length) {
        this.endReason = 'hardening check failed';
        this.emit({ kind: 'error', error: 'hardening', message: problems.join('; ') });
        this.q.close();
        return;
      }
      if (!this.vendorSessionId) {
        this.vendorSessionId = String(m.session_id);
        this.emit({ kind: 'session.init', vendorSessionId: this.vendorSessionId, vendorVersion: String(m.claude_code_version), model: String(m.model) });
      }
    } else if (m.subtype === 'session_state_changed') {
      // D-67: idle is the authoritative turn end; running starts a turn.
      if (m.state === 'running') {
        if (this.status !== 'working') this.emit({ kind: 'turn.started' });
        this.setStatus('working');
      } else if (m.state === 'idle') {
        if (this.status === 'working' || this.status === 'waiting') {
          const r = this.lastResult;
          const denied = Array.isArray(r?.permission_denials) ? r.permission_denials.length : 0;
          this.emit({ kind: 'turn.ended', reason: String(r?.terminal_reason ?? 'completed'), isError: r?.is_error === true, denied });
          this.setStatus(r?.is_error === true ? 'errored' : 'idle');
        } else if (this.status === 'starting') this.setStatus('idle');
      } else if (m.state === 'requires_action') {
        this.setStatus('waiting');
      }
    } else if (m.subtype === 'api_retry') {
      const kind = errorKindOf(m.error_status as number | null);
      this.emit({ kind: 'error', error: kind, message: `API retry ${String(m.attempt)}/${String(m.max_retries)} after HTTP ${String(m.error_status)}` });
    }
  }

  assistant(m: Record<string, unknown>): void {
    if (m.parent_tool_use_id) return; // no subagents in 0A (D-66)
    if (typeof m.error === 'string') this.emit({ kind: 'error', error: errorKindOf(m.error), message: `assistant error: ${m.error}` });
    const content = ((m.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const tool = String(block.name);
      const input = (block.input ?? {}) as Record<string, unknown>;
      const raw = [input.file_path, input.notebook_path, input.path].filter((p): p is string => typeof p === 'string');
      const rel = relativize(this.spec.worktree, raw);
      this.emit({
        kind: 'tool.called', tool, category: categoryOf(tool),
        ...(raw.length ? { paths: [...rel.paths, ...rel.outside] } : {}),
        ...(typeof input.command === 'string' ? { command: input.command.slice(0, 500) } : {}),
      });
    }
  }

  result(m: Record<string, unknown>): void {
    this.lastResult = m;
    this.resultTimes.push(Date.now());
    const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const u of Object.values((m.modelUsage ?? {}) as Record<string, Partial<Record<string, number>>>)) {
      usage.input += u.inputTokens ?? 0;
      usage.output += u.outputTokens ?? 0;
      usage.cacheRead += u.cacheReadInputTokens ?? 0;
      usage.cacheCreation += u.cacheCreationInputTokens ?? 0;
    }
    // modelUsage and total_cost_usd are running totals across the session's turns (F-16).
    this.emit({ kind: 'usage', ...usage, costUsd: Number(m.total_cost_usd ?? 0), cumulative: true });
    // D-67: a result is an error when is_error is true, whatever its subtype says (SP-09).
    if (m.is_error === true) {
      const status = m.api_error_status as number | null | undefined;
      const text = [m.result, ...((m.errors as string[] | undefined) ?? [])].filter(Boolean).join('; ').slice(0, 500);
      this.emit({ kind: 'error', error: /credit balance|billing/i.test(text) ? 'billing' : errorKindOf(status), message: `${String(m.terminal_reason ?? m.subtype)}: ${text}` });
    }
  }

  lifecycle(m: Record<string, unknown>): void {
    if (m.state !== 'started') return;
    const p = this.pending.get(String(m.command_uuid));
    if (!p) return;
    this.pending.delete(String(m.command_uuid));
    const deliveredAt = Date.now();
    // Pushed mid-turn, it rides the next tool result; pushed while idle, or held past a turn end, it opens a new turn (SP-02).
    const turnEndedFirst = this.resultTimes.some((t) => t >= p.pushedAt && t <= deliveredAt);
    const landed: Landed = p.statusAtPush === 'working' && !turnEndedFirst ? 'between_tools' : 'new_turn';
    this.emit({ kind: 'delivery', messageId: p.messageId, landed, deliveredAt });
    p.resolve({ messageId: p.messageId, landed, deliveredAt });
  }
}

export class ClaudeAdapter implements AgentAdapter<ClaudePolicyBundle, ClaudeHookBundle> {
  readonly vendor = 'claude';

  version() {
    return { pinned: PINNED.sdk, installed: installedSdkVersion() };
  }

  capabilities(version: string) {
    return claudeCapabilities(version);
  }

  compilePermissions(spec: SessionSpec): ClaudePolicyBundle {
    return compileClaudePermissions(spec);
  }

  setupHooks(spec: SessionSpec, sink: HarnessHookSink): ClaudeHookBundle {
    return claudeHooks(spec, sink);
  }

  async startSession(spec: SessionSpec, firstMessage: EnvelopedMessage, from?: string): Promise<ClaudeSession> {
    const s = this.open(spec, null);
    void s.inject(firstMessage, from).catch(() => {});
    return s;
  }

  /** Same config dir and worktree as the original session, every option re-passed (SP-07, D-65). */
  async resumeSession(ref: VendorSessionRef, spec: SessionSpec, message?: EnvelopedMessage, from?: string): Promise<ClaudeSession> {
    const s = this.open(spec, ref.vendorSessionId);
    if (message) void s.inject(message, from).catch(() => {});
    return s;
  }

  injectMessage(h: SessionHandle, msg: EnvelopedMessage, from?: string): Promise<DeliveryReceipt> {
    return this.session(h).inject(msg, from);
  }

  stopSession(h: SessionHandle, mode: 'graceful' | 'kill'): Promise<void> {
    return this.session(h).stop(mode);
  }

  getStatus(h: SessionHandle): SessionStatus {
    return this.session(h).status;
  }

  /** One consumer: harnessd. */
  observations(h: SessionHandle): AsyncIterable<Observation> {
    return this.session(h).out;
  }

  session(h: SessionHandle): ClaudeSession {
    if (!(h instanceof ClaudeSession)) throw new Error('not a ClaudeAdapter session');
    return h;
  }

  /** The full session options (agent-adapters.md §5, "startSession options"). */
  options(spec: SessionSpec, sink: HarnessHookSink, onSpawn: (pid: number) => void, resume: string | null): Options {
    const policy = this.compilePermissions(spec);
    return {
      ...policy,
      cwd: spec.worktree,
      ...(spec.model ? { model: spec.model } : {}),
      ...(resume ? { resume } : { sessionId: spec.sessionId }),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.instructions },
      mcpServers: spec.tools.length ? { [SHIM_SERVER]: shimServer(spec.tools) } : {},
      hooks: this.setupHooks(spec, sink),
      verbatimPrompts: true, // D-63, on top of client_composed on every message
      ...(spec.maxBudgetUsd ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
      // F-22: `env` replaces the inherited environment. No secret is ever an option value, since
      // options become CLI arguments visible in `ps` (SP-01); secrets only travel in env.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '/',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        ...spec.env,
        [AUTH_ENV_VARS[0]]: spec.auth.apiKey, // reaches the CLI; denied to the agent's shell (D-64)
        ...(spec.auth.baseUrl ? { ANTHROPIC_BASE_URL: spec.auth.baseUrl } : {}),
        CLAUDE_CONFIG_DIR: spec.configDir, // D-65
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', // auto memory is shared across a repo's worktrees (F-14)
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', // D-67
      },
      stderr: (line) => spec.log?.(line),
      // Our own spawn, so harnessd learns the child PID for orphan supervision (D-62).
      spawnClaudeCodeProcess: (o) => {
        const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr.on('data', (d: Buffer) => spec.log?.(d.toString()));
        child.on('error', () => {});
        if (child.pid) onSpawn(child.pid);
        return child;
      },
    };
  }

  open(spec: SessionSpec, resume: string | null): ClaudeSession {
    const v = this.version();
    if (v.installed !== v.pinned) throw new Error(`Agent SDK ${v.installed} is installed; the harness is pinned to ${v.pinned} (D-49)`);
    if (!UUID.test(spec.sessionId)) throw new Error('sessionId must be a UUID');
    if (!fs.existsSync(spec.configDir)) throw new Error(`config dir ${spec.configDir} doesn't exist`);
    // Sandbox and permission rules match resolved paths; the init check compares cwd too.
    const real = { ...spec, worktree: fs.realpathSync(spec.worktree), gitCommonDir: fs.realpathSync(spec.gitCommonDir) };
    const session = new ClaudeSession(real);
    const sink: HarnessHookSink = { observe: (o) => session.emit(o), gate: () => session.verdict };
    session.start(this.options(real, sink, (pid) => {
      session.pid = pid;
      session.emit({ kind: 'process.started', pid });
    }, resume));
    return session;
  }
}
