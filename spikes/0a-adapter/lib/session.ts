// THROWAWAY spike code (D-59). Hardened session options + a recorder.
import { query, type Options, type SDKMessage, type SDKUserMessage, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { Mock } from './mock-api.ts';
import { DUMMY_KEY } from './mock-api.ts';

export const MODEL = 'claude-haiku-4-5-20251001';

/** An input queue the harness controls: push() a message into a live session. */
export class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiters: ((v: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(text: string, extra: Partial<SDKUserMessage> = {}): string {
    const uuid = extra.uuid ?? randomUUID();
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid, ...extra } as SDKUserMessage;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false }); else this.queue.push(msg);
    return uuid as string;
  }
  close() { this.closed = true; for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export type HookRecord = { t: number; event: string; tool?: string; input?: any; response?: any; raw: any };

/** In-process hook callbacks that record everything (edit/read capture). */
export function recordingHooks(sink: HookRecord[], extra: Partial<Record<string, HookCallbackMatcher[]>> = {}) {
  const rec = (event: string) => async (input: any) => {
    sink.push({ t: Date.now(), event, tool: input.tool_name, input: input.tool_input, response: input.tool_response, raw: input });
    return {};
  };
  const hooks: any = {};
  for (const ev of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'PermissionDenied', 'InstructionsLoaded', 'Notification', 'FileChanged', 'CwdChanged']) {
    hooks[ev] = [{ hooks: [rec(ev)] }];
  }
  for (const [ev, matchers] of Object.entries(extra)) hooks[ev] = [...(hooks[ev] ?? []), ...(matchers ?? [])];
  return hooks;
}

export function baseEnv(mock: Mock, configDir: string, more: Record<string, string> = {}) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
    HOME: process.env.HOME!,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    ANTHROPIC_API_KEY: DUMMY_KEY,
    ANTHROPIC_BASE_URL: mock.url,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...more,
  } as Record<string, string>;
}

/** The ClaudeAdapter's proposed hardened options (agent-adapters.md §5), parameterized for experiments. */
export function hardenedOptions(p: {
  cwd: string; mock: Mock; configDir: string; hooks?: any; env?: Record<string, string>;
  denyPaths?: string[]; sandboxFs?: any; overrides?: Partial<Options>;
}): Options {
  const deny = (p.denyPaths ?? []).flatMap((d) => [`Edit(/${d}/**)`, `Read(/${d}/**)`]);
  return {
    cwd: p.cwd,
    model: MODEL,
    permissionMode: 'dontAsk',
    allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'mcp__harness__*'],
    disallowedTools: ['SendMessage', 'ListAgents'],
    settingSources: [],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'HARNESS-APPEND-MARKER' },
    env: baseEnv(p.mock, p.configDir, p.env),
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, ...(p.sandboxFs ? { filesystem: p.sandboxFs } : {}) },
    settings: { permissions: { deny }, bashEditDiffEnabled: true, crossSessionInbound: 'refuse' } as any,
    hooks: p.hooks,
    ...p.overrides,
  };
}

export type Run = {
  messages: (SDKMessage & { _t: number })[]; init?: any; results: any[]; error?: string; stderr: string[];
  q?: ReturnType<typeof query>;
};

/** Start a session and record its stream in the background. Await `done` for the end. */
export function startRun(prompt: string | AsyncIterable<SDKUserMessage>, options: Options, onMessage?: (m: SDKMessage) => void) {
  const run: Run = { messages: [], results: [], stderr: [] };
  const q = query({ prompt, options: { ...options, stderr: (d) => run.stderr.push(d) } });
  run.q = q;
  const done = (async () => {
    try {
      for await (const m of q) {
        const mm = Object.assign(m, { _t: Date.now() });
        run.messages.push(mm);
        if (m.type === 'system' && (m as any).subtype === 'init' && !run.init) run.init = m;
        if (m.type === 'result') run.results.push(m);
        onMessage?.(m);
      }
    } catch (e: any) {
      run.error = String(e?.message ?? e);
    }
    return run;
  })();
  return { run, q, done };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Compact view of a run's messages for logs. */
export function compact(run: Run) {
  return run.messages.map((m: any) => {
    const base: any = { t: m._t, type: m.type, subtype: m.subtype };
    if (m.type === 'assistant') base.content = m.message.content.map((c: any) => c.type === 'tool_use' ? { tool: c.name, input: c.input } : { text: c.text?.slice(0, 120) });
    if (m.type === 'user') base.content = typeof m.message.content === 'string' ? m.message.content.slice(0, 160) : m.message.content.map((c: any) => c.type === 'tool_result' ? { result: (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 200), err: c.is_error } : { text: c.text?.slice(0, 160) });
    if (m.type === 'user') { base.uuid = m.uuid; base.isReplay = m.isReplay; base.origin = m.origin; }
    if (m.type === 'result') Object.assign(base, { is_error: m.is_error, num_turns: m.num_turns, usage: m.usage, total_cost_usd: m.total_cost_usd, result: String(m.result ?? '').slice(0, 120), errors: m.errors });
    return base;
  });
}
