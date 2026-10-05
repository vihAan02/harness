// THROWAWAY spike code (D-59). Hardened session options + a recorder.
import { query, type Options, type SDKMessage, type SDKUserMessage, type HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { Mock } from './mock-api.ts';
import { DUMMY_KEY } from './mock-api.ts';

/**
 * The model, and optionally a third-party Anthropic-compatible endpoint, for real runs (D-87). Defaults to
 * Anthropic's Haiku 4.5. For OpenRouter, the default since D-104 (the same settings as its table in
 * docs/examples/providers.toml):
 *   SPIKE_BASE_URL=https://openrouter.ai/api SPIKE_KEY_ENV=OPENROUTER_API_KEY SPIKE_AUTH_SCHEME=bearer \
 *   SPIKE_MODEL=deepseek/deepseek-v4.1-flash SPIKE_EXTRA_BODY='{"provider":{"only":["deepseek"],"allow_fallbacks":false}}'
 * For DeepSeek's own endpoint:
 *   SPIKE_BASE_URL=https://api.deepseek.com/anthropic SPIKE_KEY_ENV=DEEPSEEK_API_KEY SPIKE_MODEL=deepseek-flash
 * SPIKE_AUTH_SCHEME=bearer for endpoints that take only a bearer token (OpenRouter, Kimi). SPIKE_EXTRA_BODY is
 * merged into every request (CLAUDE_CODE_EXTRA_BODY, F-29), e.g. to pin a router's provider.
 */
export const MODEL = process.env.SPIKE_MODEL ?? 'claude-haiku-4-5-20251001';
export const PROVIDER = {
  baseUrl: process.env.SPIKE_BASE_URL,
  keyEnv: process.env.SPIKE_KEY_ENV ?? 'ANTHROPIC_API_KEY',
  scheme: (process.env.SPIKE_AUTH_SCHEME === 'bearer' ? 'bearer' : 'x-api-key') as 'bearer' | 'x-api-key',
};

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

/** Shared-.git entries the sandbox write-denies (D-60, SP-05). */
export const GIT_DENY_WRITE = ['config', 'hooks', 'refs', 'objects', 'packed-refs', 'info', 'worktrees', 'HEAD', 'index', 'logs'];

/**
 * The CORRECTED session config the spike arrived at (D-45, D-46, D-60 to D-68). `hardenedOptions`
 * above is the pre-spike proposal that the experiments attack; this is what ClaudeAdapter starts from.
 * `auth.baseUrl` is set only for the mock; real runs talk to the Anthropic API.
 */
export function correctedOptions(p: {
  cwd: string; configDir: string; gitCommonDir: string; auth: { apiKey: string; baseUrl?: string; scheme?: 'x-api-key' | 'bearer' };
  denyRead?: string[]; shimTools?: string[]; mcpServers?: Options['mcpServers']; append?: string;
  hooks?: any; env?: Record<string, string>; overrides?: Partial<Options>;
}): Options {
  const wt = p.cwd;
  return {
    cwd: wt,
    model: MODEL,
    permissionMode: 'dontAsk',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], // D-66
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', `Edit(/${wt}/**)`, `Write(/${wt}/**)`, ...(p.shimTools ?? [])], // D-60: never bare Edit/Write
    disallowedTools: ['SendMessage', 'ListAgents'], // D-46
    settingSources: [], // D-45
    systemPrompt: { type: 'preset', preset: 'claude_code', append: p.append ?? '' },
    mcpServers: p.mcpServers,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      ANTHROPIC_API_KEY: p.auth.apiKey, // D-48 pass-through, hidden from the agent's shell below (D-64)
      ...(p.auth.scheme === 'bearer' ? { ANTHROPIC_AUTH_TOKEN: p.auth.apiKey } : {}), // D-87: both, so apiKeySource stays the API key
      ...(p.auth.baseUrl ? { ANTHROPIC_BASE_URL: p.auth.baseUrl } : {}),
      // D-87 / F-25, F-26: on a third-party endpoint, pin every model alias and drop first-party-only fields.
      ...(PROVIDER.baseUrl ? {
        ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
        CLAUDE_CODE_SUBAGENT_MODEL: MODEL, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
        ...(process.env.SPIKE_EXTRA_BODY ? { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(JSON.parse(process.env.SPIKE_EXTRA_BODY)) } : {}),
      } : {}),
      CLAUDE_CONFIG_DIR: p.configDir, // D-65
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', // D-67
      ...p.env,
    },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true,
      filesystem: { denyWrite: GIT_DENY_WRITE.map((x) => `${p.gitCommonDir}/${x}`) }, // D-60
      credentials: { envVars: [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }] }, // D-64, D-87
    } as any,
    settings: {
      permissions: { allow: [`Edit(/${wt}/**)`], deny: (p.denyRead ?? []).map((d) => `Read(/${d}/**)`) }, // D-60, D-61
      bashEditDiffEnabled: true,
      crossSessionInbound: 'refuse',
    } as any,
    hooks: p.hooks,
    ...p.overrides,
  };
}

/** D-62: a PreToolUse callback that can't fail open. A throw inside `observe` denies the call. */
export function deadManPreToolUse(observe: (input: any) => void): HookCallbackMatcher {
  return {
    timeout: 5,
    hooks: [async (input: any) => {
      try { observe(input); return {}; } catch {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'harness supervisor error' } };
      }
    }],
  } as HookCallbackMatcher;
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
