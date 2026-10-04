// ClaudeAdapter: Claude Code through the Agent SDK in TypeScript (agent-adapters.md §5).
// One session = one `query()` over a harness-controlled input queue (streaming input, F-02).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentAdapter, DeliveryReceipt, EnvelopedMessage, ErrorKind, HarnessHookSink, Landed, Observation, Prices, SessionHandle,
  SessionSpec, SessionStatus, ToolCategory, VendorSessionRef,
} from '../adapter.ts';
import { priceOf, sessionCost, type ModelTokens } from '../cost.ts';
import { isReservedEnvName } from '../env.ts';
import { AsyncQueue } from '../queue.ts';
import { deniedEntries, realish } from '../readpolicy.ts';
import { claudeHooks, NOTICE_CONTEXT_CAP, relativize, type ClaudeHookBundle } from './hooks.ts';
import { BASE_TOOLS, compileClaudePermissions, SHIM_SERVER, shimToolName, type ClaudePolicyBundle } from './policy.ts';
import { shimServer } from './shim.ts';
import { BUILTIN_SKILLS, claudeCapabilities, installedSdkVersion, PINNED } from './version.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Model ids become a CLI argument, so one may never start with `-` (D-87). Allows `[1m]`, `org/model:free`. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/;
/**
 * Claude Code's own model aliases. A configured model must be a full id: the hardening check compares it
 * with the model the CLI reports, and pinning the alias variables to an alias would point them at themselves.
 */
const CLI_ALIASES = new Set(['default', 'best', 'sonnet', 'opus', 'haiku', 'fable', 'opusplan']);
export function isModelAlias(id: string): boolean {
  return CLI_ALIASES.has(id.replace(/\[[^\]]*\]$/, '').toLowerCase());
}
/**
 * What the pinned CLI charges, in USD per million tokens, for a model id it can't price (`costBasis:
 * 'unknown'`): measured against 2.1.287 with the scripted mock (F-27). Used only to scale its budget cap.
 */
const CLI_GUESS_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }; // cache rates: the same model's (assumed, not probed)
/** Graceful stop: how long to wait for the CLI to wind down after interrupt() before closing it. */
const GRACE_MS = 5000;
/** Between notices attached to the same tool batch. */
const NOTICE_SEPARATOR = '\n\n';

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
export function hardeningProblems(init: Record<string, unknown>, spec: Pick<SessionSpec, 'worktree' | 'tools' | 'model'>): string[] {
  const problems: string[] = [];
  if (init.claude_code_version !== PINNED.cli) problems.push(`Claude Code ${String(init.claude_code_version)} is not the pinned ${PINNED.cli} (D-49)`);
  // Bearer providers get the key in both variables, so this holds for every scheme (D-87, C-21).
  if (init.apiKeySource !== 'ANTHROPIC_API_KEY') problems.push(`auth came from ${String(init.apiKeySource)}, not the API key (D-56)`);
  if (spec.model && init.model !== spec.model.id) problems.push(`model is ${String(init.model)}, not the configured ${spec.model.id} (D-87)`);
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
type QueuedNotice = { msg: EnvelopedMessage; from?: string; resolve: (r: DeliveryReceipt) => void; reject: (e: Error) => void };

export class ClaudeSession implements SessionHandle {
  id: string;
  pid: number | null = null;
  vendorSessionId: string | null = null;
  status: SessionStatus = 'starting';
  spec: SessionSpec;
  input = new AsyncQueue<SDKUserMessage>();
  out = new AsyncQueue<Observation>();
  pending = new Map<string, PendingDelivery>();
  /** High-priority notices waiting for the next tool batch, oldest first (D-99). */
  notices: QueuedNotice[] = [];
  resultTimes: number[] = [];
  lastResult: Record<string, unknown> | null = null;
  q!: Query;
  done: Promise<void> = Promise.resolve();
  endReason = 'ended';
  /** Settles once the first init is checked: null if the hardening holds, else why it doesn't. Tools wait on it. */
  verdict: Promise<string | null>;
  /** While set, every tool call is denied with this reason (AgentAdapter.setHold, D-53). */
  holdReason: string | null = null;
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

  /** D-99: attached after the next tool batch while a turn runs; otherwise, or if too long to attach whole, injected. */
  queueNotice(msg: EnvelopedMessage, from?: string): Promise<DeliveryReceipt> {
    if (this.status === 'ended') return Promise.reject(new Error(`session ${this.id} has ended`));
    if ((this.status !== 'working' && this.status !== 'waiting') || msg.text.length > NOTICE_CONTEXT_CAP) return this.inject(msg, from);
    return new Promise((resolve, reject) => { this.notices.push({ msg, ...(from ? { from } : {}), resolve, reject }); });
  }

  /** For the PostToolBatch hook: the queued notices, oldest first, that fit in `maxChars` together. Delivered once taken. */
  takeNotices(maxChars: number): string | null {
    const taken: QueuedNotice[] = [];
    let size = 0;
    while (this.notices.length) {
      const next = this.notices[0]!.msg.text.length + (taken.length ? NOTICE_SEPARATOR.length : 0);
      if (size + next > maxChars) break;
      size += next;
      taken.push(this.notices.shift()!);
    }
    if (!taken.length) return null;
    const deliveredAt = Date.now();
    for (const n of taken) {
      this.emit({ kind: 'delivery', messageId: n.msg.id, landed: 'between_tools', deliveredAt });
      n.resolve({ messageId: n.msg.id, landed: 'between_tools', deliveredAt });
    }
    return taken.map((n) => n.msg.text).join(NOTICE_SEPARATOR);
  }

  withdrawNotice(messageId: string): boolean {
    const i = this.notices.findIndex((n) => n.msg.id === messageId);
    if (i < 0) return false;
    this.notices.splice(i, 1)[0]!.reject(new Error('withdrawn: a newer notice replaced it'));
    return true;
  }

  /** At turn end, notices no tool batch took are injected, and open a new turn (D-99). */
  flushNotices(): void {
    for (const n of this.notices.splice(0)) this.inject(n.msg, n.from).then(n.resolve, n.reject);
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
    for (const n of this.notices.splice(0)) n.reject(new Error(`session ${this.id} ended before the notice was delivered`));
    this.setStatus('ended');
    this.emit({ kind: 'ended', reason: this.endReason });
    this.out.end();
  }

  handle(m: Record<string, unknown>): void {
    const type = m.type;
    if (type === 'system') this.system(m);
    else if (type === 'assistant') this.assistant(m);
    else if (type === 'user') this.toolResults(m);
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
          const denials = Array.isArray(r?.permission_denials) ? (r.permission_denials as { tool_use_id?: unknown }[]) : [];
          this.emit({
            kind: 'turn.ended', reason: String(r?.terminal_reason ?? 'completed'), isError: r?.is_error === true,
            denied: denials.length, deniedIds: denials.map((d) => String(d.tool_use_id ?? '')).filter(Boolean),
          });
          this.setStatus(r?.is_error === true ? 'errored' : 'idle');
        } else if (this.status === 'starting') this.setStatus('idle');
        this.flushNotices();
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
        kind: 'tool.called', toolUseId: String(block.id ?? ''), tool, category: categoryOf(tool),
        ...(raw.length ? { paths: [...rel.paths, ...rel.outside] } : {}),
        ...(typeof input.command === 'string' ? { command: input.command.slice(0, 500) } : {}),
      });
    }
  }

  /** Tool results come back in user messages: which calls finished, and whether they failed (the missed-hook monitor, H-03). */
  toolResults(m: Record<string, unknown>): void {
    if (m.parent_tool_use_id) return;
    const content = (m.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'tool_result') this.emit({ kind: 'tool.result', toolUseId: String(block.tool_use_id ?? ''), isError: block.is_error === true });
    }
  }

  result(m: Record<string, unknown>): void {
    this.lastResult = m;
    this.resultTimes.push(Date.now());
    const usage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    const byModel: Record<string, ModelTokens> = {};
    for (const [id, u] of Object.entries((m.modelUsage ?? {}) as Record<string, Partial<Record<string, number>> & { costBasis?: string }>)) {
      const t: ModelTokens = {
        input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheCreation: u.cacheCreationInputTokens ?? 0,
        vendorCostUsd: u.costUSD ?? 0, vendorBasis: u.costBasis === 'list' || u.costBasis === 'managed' ? 'list' : 'unknown',
      };
      byModel[id] = t;
      usage.input += t.input;
      usage.output += t.output;
      usage.cacheRead += t.cacheRead;
      usage.cacheCreation += t.cacheCreation;
    }
    // modelUsage is a running total across the session's turns (F-16). The vendor's own cost is a guess for
    // models it doesn't know (F-27), so configured prices win where every model has them (D-87).
    const cost = sessionCost(byModel, this.spec.model?.prices);
    this.emit({ kind: 'usage', ...usage, ...cost, models: Object.keys(byModel).sort(), cumulative: true });
    if (m.terminal_reason === 'budget_exhausted' || m.subtype === 'error_max_budget_usd') {
      this.emit({ kind: 'error', error: 'budget', message: `the CLI's own budget cap stopped the session at its estimate of $${Number(m.total_cost_usd ?? 0).toFixed(4)}` });
    }
    const budget = this.spec.maxBudgetUsd;
    if (budget && cost.costUsd >= budget && this.status !== 'ended') {
      this.endReason = 'budget exceeded';
      this.emit({ kind: 'error', error: 'budget', message: `the session has cost $${cost.costUsd.toFixed(4)} (${cost.costBasis} prices), over its $${budget} budget` });
      this.q.close();
      return;
    }
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

  /** The read policy's static deny list is read from the filesystem here, when the session opens (D-98). */
  compilePermissions(spec: SessionSpec): ClaudePolicyBundle {
    if (!spec.readPolicy) return compileClaudePermissions(spec);
    const { entries, coarse } = deniedEntries(spec.readPolicy);
    if (coarse) spec.log?.(`harness: read confinement's static deny list was over budget; using ${entries.length} top-level entries, the rest is confined at call time and by the sandbox\n`);
    return compileClaudePermissions(spec, entries);
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

  queueNotice(h: SessionHandle, msg: EnvelopedMessage, from?: string): Promise<DeliveryReceipt> {
    return this.session(h).queueNotice(msg, from);
  }

  withdrawNotice(h: SessionHandle, messageId: string): boolean {
    return this.session(h).withdrawNotice(messageId);
  }

  stopSession(h: SessionHandle, mode: 'graceful' | 'kill'): Promise<void> {
    return this.session(h).stop(mode);
  }

  setHold(h: SessionHandle, reason: string | null): void {
    this.session(h).holdReason = reason;
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
      ...(spec.model ? { model: spec.model.id } : {}),
      ...(resume ? { resume } : { sessionId: spec.sessionId }),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.instructions },
      mcpServers: spec.tools.length ? { [SHIM_SERVER]: shimServer(spec.tools) } : {},
      hooks: this.setupHooks(spec, sink),
      verbatimPrompts: true, // D-63, on top of client_composed on every message
      ...(spec.maxBudgetUsd ? { maxBudgetUsd: vendorBudget(spec.maxBudgetUsd, spec.model) } : {}),
      env: sessionEnv(spec),
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

  /** Refuses secrets, model ids and endpoints that could misroute the key (D-87). A method so a test can prove what it prevents. */
  checkInputs(spec: SessionSpec): void {
    checkSessionInputs(spec);
  }

  open(spec: SessionSpec, resume: string | null): ClaudeSession {
    const v = this.version();
    if (v.installed !== v.pinned) throw new Error(`Agent SDK ${v.installed} is installed; the harness is pinned to ${v.pinned} (D-49)`);
    if (!UUID.test(spec.sessionId)) throw new Error('sessionId must be a UUID');
    this.checkInputs(spec);
    if (!fs.existsSync(spec.configDir)) throw new Error(`config dir ${spec.configDir} doesn't exist`);
    // Sandbox and permission rules match resolved paths, in their on-disk case (native realpath); the init check compares cwd too.
    const worktree = fs.realpathSync.native(spec.worktree);
    const real = {
      ...spec, worktree, gitCommonDir: fs.realpathSync.native(spec.gitCommonDir),
      ...(spec.readPolicy ? {
        readPolicy: {
          denyRoots: spec.readPolicy.denyRoots.map(realish),
          // The CLI saves a tool result too big for the conversation under its config dir and tells the agent
          // to read it there (F-101): that one directory of this session's is readable too.
          allowRoots: [...spec.readPolicy.allowRoots, toolResultsDir(spec.configDir, worktree, spec.sessionId)].map(realish),
          ...(spec.readPolicy.allowLinks ? { allowLinks: spec.readPolicy.allowLinks } : {}),
        },
      } : {}),
    };
    const session = new ClaudeSession(real);
    const sink: HarnessHookSink = {
      observe: (o) => session.emit(o),
      gate: async () => (await session.verdict) ?? session.holdReason,
      notices: (maxChars) => session.takeNotices(maxChars),
    };
    session.start(this.options(real, sink, (pid) => {
      session.pid = pid;
      session.emit({ kind: 'process.started', pid });
    }, resume));
    return session;
  }
}

/**
 * Refuses a session whose secrets could reroute the key or change the CLI (D-87, TH-21), and model ids
 * the CLI would misread. harnessd checks the same when it reads its config; this is the second check.
 */
export function checkSessionInputs(spec: Pick<SessionSpec, 'secrets' | 'model' | 'auth'>): void {
  const reserved = Object.keys(spec.secrets).filter(isReservedEnvName);
  if (reserved.length) throw new Error(`secrets may not set ${reserved.join(', ')}: the CLI reads those names (D-87)`);
  for (const id of [spec.model?.id, spec.model?.background]) {
    if (id !== undefined && !MODEL_ID.test(id)) throw new Error(`model id ${JSON.stringify(id)} is malformed`);
    if (id !== undefined && isModelAlias(id)) throw new Error(`model id ${JSON.stringify(id)} is a Claude Code alias; configure a full model id`);
  }
  const url = spec.auth.baseUrl;
  if (url !== undefined) {
    const u = new URL(url);
    // Plain http only to the literal IPv4 loopback, for test doubles: any agent with a port block may bind
    // loopback ports, so a local endpoint could be squatted (and `localhost` resolves to [::1] too). harnessd's
    // config accepts https only (TH-21).
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')) || u.username || u.password || u.search || u.hash) {
      throw new Error('the model endpoint must be https, with no credentials, query or fragment (D-87)');
    }
  }
}

/**
 * The CLI's environment (F-22: `env` replaces the inherited one). No secret is ever an option value, since
 * options become CLI arguments visible in `ps` (SP-01); secrets only travel in env. Order: the base, then
 * the task's secrets (never a reserved name), then harness-set values, which always win.
 */
/** Where the pinned CLI saves a session's oversized tool results: `<config>/projects/<cwd, non-alphanumerics as ->/<session>/tool-results` (F-101). */
export function toolResultsDir(configDir: string, worktree: string, sessionId: string): string {
  return path.join(configDir, 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'tool-results');
}

export function sessionEnv(spec: Pick<SessionSpec, 'env' | 'secrets' | 'auth' | 'model' | 'configDir' | 'readPolicy'>): Record<string, string> {
  const { auth, model } = spec;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    ...spec.secrets,
    ...spec.env,
    // Both auth variables reach the CLI and are denied to the agent's shell (D-64). A bearer provider gets
    // the key in both, so the CLI still reports the API key as its auth source (F-24, C-21): that check is
    // what rules out a subscription login (D-56, D-87).
    ANTHROPIC_API_KEY: auth.apiKey,
    ...(auth.scheme === 'bearer' ? { ANTHROPIC_AUTH_TOKEN: auth.apiKey } : {}),
    ...(auth.baseUrl ? { ANTHROPIC_BASE_URL: auth.baseUrl } : {}),
    CLAUDE_CONFIG_DIR: spec.configDir, // D-65
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', // auto memory is shared across a repo's worktrees (F-14)
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', // also keeps feature flags and telemetry off third-party runs (F-28)
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', // D-67
    // Every Bash command starts in the worktree: the shell's directory never carries over from an earlier
    // command, so harnessd resolves a command's relative paths against the worktree correctly (F-97).
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
    // Under read confinement the agent's Git can't read the human's global config (~/.gitconfig,
    // ~/.config/git), and Git stops on a config file it can't read. Agents never commit (D-50), so its Git
    // gets none: the same, empty, global config on every machine (D-98).
    ...(spec.readPolicy ? {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.attributesFile', GIT_CONFIG_VALUE_1: '/dev/null',
    } : {}),
  };
  if (model) {
    // Every alias resolves to the configured model, so nothing bills at another model's price (F-25).
    Object.assign(env, {
      ANTHROPIC_DEFAULT_OPUS_MODEL: model.id, ANTHROPIC_DEFAULT_SONNET_MODEL: model.id, CLAUDE_CODE_SUBAGENT_MODEL: model.id,
      ...(model.background ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: model.background } : {}),
      ...(model.stripExperimental ? { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' } : {}), // F-26
      ...(model.contextTokens ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(model.contextTokens) } : {}),
      ...(model.compactWindowTokens ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(model.compactWindowTokens) } : {}),
      ...(model.maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(model.maxOutputTokens) } : {}),
      ...(model.extraBody ? { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(model.extraBody) } : {}), // F-29
    });
  }
  return env;
}

/**
 * The cap passed to the CLI. The session's own budget is enforced by the adapter against the reported
 * cost; the CLI's cap is a backstop. For a model the CLI can't price, its cost is a guess at a far higher
 * rate (F-27), so the cap is scaled up by that ratio: it then trips at most about 25% over budget, never early.
 */
export function vendorBudget(budget: number, model: SessionSpec['model']): number {
  const p: Prices | undefined = model?.prices ? priceOf(model.prices, model.id) : undefined;
  if (!p) return Math.max(0.01, budget);
  const g = CLI_GUESS_PER_MTOK;
  const rates: [number, number][] = [[g.input, p.input], [g.output, p.output], [g.cacheRead, p.cacheRead ?? p.input], [g.cacheWrite, p.cacheWrite ?? p.input]];
  // A free rate makes the guess infinitely higher than the real cost: the CLI's cap is then no use as a
  // backstop, so it's set out of the way and the adapter's own check is the only one.
  if (rates.some(([, real]) => real === 0)) return 1000;
  const ratio = Math.max(1, ...rates.map(([guess, real]) => guess / real));
  return Math.max(0.01, Math.ceil(budget * ratio * 100) / 100);
}
