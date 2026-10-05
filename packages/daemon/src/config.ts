// harnessd's local config, ~/.harness/config.toml. It is the local root of trust (D-32):
// - only repos listed here are worked on, a deny-by-default allowlist;
// - only secrets listed per project can reach agents (D-52);
// - repo config can only lower these limits, never raise them.
//
//   device_id = "dev_…"
//   principal = "human_…"
//   server_url = "ws://127.0.0.1:7400"
//   [limits]  max_concurrent_agents = 2, ports_per_agent = 10, port_range = [3100, 3999]
//   [setup]   allowed_domains = ["registry.npmjs.org"], timeout_seconds = 900
//   [agents]  provider = "openrouter", max_budget_usd = 2   (both optional; see [providers.<name>] below)
//             model = "claude-haiku-4-5"                  (only without a provider: the vendor's default endpoint)
//             read_allow = ["~/.cache/ms-playwright"]     (extra paths agents may read inside the home directory, D-98)
//   [providers.<name>]  a model endpoint (D-87; README "Choosing a model provider"). Nothing here is a
//             secret: key_env names the variable in harnessd's environment that holds the key.
//             base_url = "https://…", auth = "x-api-key" | "bearer", key_env = "…_API_KEY", model = "…",
//             background_model, max_context_tokens, auto_compact_window, max_output_tokens,
//             strip_experimental_betas, extra_body = { … }, [providers.<name>.prices."<model>"] input/output/cache_read/cache_write (USD per 1M tokens)
//   [[projects]]  id = "prj_…", repo = "/abs/path", base_branch = "main", secrets = ["DATABASE_URL"]
import fs from 'node:fs';
import path from 'node:path';
import { isModelAlias, isReservedEnvName, MODEL_ID, priceOf, type Prices } from '@harness/adapters';
import { parse } from 'smol-toml';
import { readPrivateFile, type Home } from './home.ts';

export type ProjectConfig = { id: string; repo: string; baseBranch: string; secrets: string[] };
/** One model endpoint (D-87). Product code knows no provider by name; these come only from the local config. */
export type ProviderConfig = {
  name: string;
  baseUrl: string | null; // null: the vendor's own endpoint
  auth: 'x-api-key' | 'bearer';
  keyEnv: string;
  model: string;
  backgroundModel: string | null;
  maxContextTokens: number | null;
  autoCompactWindow: number | null;
  maxOutputTokens: number | null;
  stripExperimentalBetas: boolean;
  extraBody: Record<string, unknown> | null;
  prices: Record<string, Prices>;
};
export type LocalConfig = {
  deviceId: string; principal: string; serverUrl: string; token: string;
  projects: ProjectConfig[];
  limits: { maxConcurrentAgents: number; portsPerAgent: number; portRange: [number, number] };
  setup: { allowedDomains: string[]; timeoutSeconds: number };
  agents: { provider: string | null; model: string | null; maxBudgetUsd: number | null; readAllow: string[] };
  providers: Record<string, ProviderConfig>;
};

/** Linux hands out ephemeral ports from 32768 and macOS from 49152; agent port blocks stay below both (D-68). */
export const EPHEMERAL_FLOOR = 32768;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const PROVIDER_NAME = /^[A-Za-z0-9_-]{1,40}$/;
/** Request fields `extra_body` may not override: what the harness or the CLI decides (D-87). */
const EXTRA_BODY_DENY = ['model', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'metadata', 'mcp_servers', 'container', 'max_tokens'];

export function loadConfig(home: Home): LocalConfig {
  let raw: Record<string, unknown>;
  try {
    raw = parse(fs.readFileSync(home.config, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`can't read ${home.config}: ${(e as Error).message}`);
  }
  return parseConfig(raw, loadToken(home));
}

function loadToken(home: Home): string {
  const token = process.env.HARNESS_LOCAL_TOKEN ?? (fs.existsSync(home.token) ? readPrivateFile(home.token).trim() : '');
  if (token.length < 32) throw new Error(`no local token: put the server's token (32+ characters) in ${home.token} (chmod 600) or HARNESS_LOCAL_TOKEN`);
  return token;
}

export function parseConfig(raw: Record<string, unknown>, token: string): LocalConfig {
  const str = (v: unknown, name: string, re?: RegExp) => {
    if (typeof v !== 'string' || !v || (re && !re.test(v))) throw new Error(`config: ${name} is missing or malformed`);
    return v;
  };
  const int = (v: unknown, name: string, fallback: number, min: number, max: number) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`config: ${name} must be an integer from ${min} to ${max}`);
    return v;
  };
  const strings = (v: unknown, name: string, re: RegExp) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && re.test(s))) throw new Error(`config: ${name} is malformed`);
    return v as string[];
  };
  const table = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});

  const limits = table(raw.limits);
  const range = limits.port_range ?? [3100, 3999];
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger)) throw new Error('config: limits.port_range must be [start, end]');
  const [start, end] = range as [number, number];
  if (start < 1024 || end < start || end >= EPHEMERAL_FLOOR) throw new Error(`config: limits.port_range must lie within 1024..${EPHEMERAL_FLOOR - 1}`);

  const setup = table(raw.setup);
  const agents = table(raw.agents);
  const budget = agents.max_budget_usd;
  if (budget !== undefined && (typeof budget !== 'number' || !(budget > 0) || budget > 1000)) throw new Error('config: agents.max_budget_usd must be a number above 0, at most 1000');
  const providers: Record<string, ProviderConfig> = Object.assign(Object.create(null) as Record<string, ProviderConfig>,
    Object.fromEntries(Object.entries(table(raw.providers)).map(([name, v]) => [name, parseProvider(name, table(v))])));
  const provider = agents.provider === undefined ? null : str(agents.provider, 'agents.provider', PROVIDER_NAME);
  if (provider && !Object.hasOwn(providers, provider)) throw new Error(`config: agents.provider is "${provider}", but there's no [providers.${provider}]`);
  if (provider && agents.model !== undefined) throw new Error('config: set the model in [providers.<name>], not agents.model, when agents.provider is set');
  const serverUrl = str(raw.server_url ?? 'ws://127.0.0.1:7400', 'server_url');
  if (!/^wss?:\/\//.test(serverUrl)) throw new Error('config: server_url must be ws:// or wss://');

  const projects = (Array.isArray(raw.projects) ? raw.projects : []).map((p, i) => {
    const t = table(p);
    const repo = str(t.repo, `projects[${i}].repo`);
    if (!path.isAbsolute(repo)) throw new Error(`config: projects[${i}].repo must be an absolute path`);
    return {
      id: str(t.id, `projects[${i}].id`, ID),
      repo: path.resolve(repo),
      baseBranch: str(t.base_branch ?? 'main', `projects[${i}].base_branch`, /^[A-Za-z0-9._/-]{1,200}$/),
      secrets: strings(t.secrets, `projects[${i}].secrets`, SECRET_NAME).map((n) => {
        if (isReservedEnvName(n)) throw new Error(`config: projects[${i}].secrets can't include ${n}: the agent CLI reads that name (D-87)`);
        return n;
      }),
    };
  });

  return {
    deviceId: str(raw.device_id, 'device_id', ID),
    principal: str(raw.principal, 'principal', ID),
    serverUrl,
    token,
    projects,
    limits: {
      maxConcurrentAgents: int(limits.max_concurrent_agents, 'limits.max_concurrent_agents', 2, 1, 2), // fixed at 2 in 0A (D-38)
      portsPerAgent: int(limits.ports_per_agent, 'limits.ports_per_agent', 10, 1, 100),
      portRange: [start, end],
    },
    setup: {
      allowedDomains: strings(setup.allowed_domains ?? ['registry.npmjs.org'], 'setup.allowed_domains', /^[A-Za-z0-9*.-]{1,253}$/),
      timeoutSeconds: int(setup.timeout_seconds, 'setup.timeout_seconds', 900, 10, 7200),
    },
    agents: {
      provider,
      model: agents.model === undefined ? null : noAlias(str(agents.model, 'agents.model', MODEL_ID), 'agents.model'),
      maxBudgetUsd: (budget as number | undefined) ?? null,
      // Absolute, or ~/ for the home directory. Never a credential path: readPolicyFor drops those (D-98).
      readAllow: strings(agents.read_allow, 'agents.read_allow', /^(~\/|\/)[^\u0000-\u001f\u007f]{1,1000}$/),
    },
    providers,
  };
}

function noAlias(id: string, name: string): string {
  if (isModelAlias(id)) throw new Error(`config: ${name} is "${id}", a Claude Code alias; use a full model id such as claude-haiku-4-5 (D-87)`);
  return id;
}

/** One `[providers.<name>]` table. Validated strictly: it decides where the key is sent (D-87, TH-21). */
export function parseProvider(name: string, t: Record<string, unknown>): ProviderConfig {
  const where = `providers.${name}`;
  if (!PROVIDER_NAME.test(name)) throw new Error(`config: provider name "${name}" is malformed`);
  const known = ['base_url', 'auth', 'key_env', 'model', 'background_model', 'max_context_tokens', 'auto_compact_window', 'max_output_tokens', 'strip_experimental_betas', 'extra_body', 'prices'];
  const unknown = Object.keys(t).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`config: ${where} has unknown keys: ${unknown.join(', ')}`);
  const text = (k: string, re: RegExp) => {
    const v = t[k];
    if (typeof v !== 'string' || !re.test(v)) throw new Error(`config: ${where}.${k} is missing or malformed`);
    return v;
  };
  const num = (k: string, min: number, max: number, integer = true) => {
    const v = t[k];
    if (v === undefined) return null;
    if (typeof v !== 'number' || (integer && !Number.isSafeInteger(v)) || !(v >= min) || v > max) throw new Error(`config: ${where}.${k} must be a number from ${min} to ${max}`);
    return v;
  };
  let baseUrl: string | null = null;
  if (t.base_url !== undefined) {
    let u: URL;
    try { u = new URL(String(t.base_url)); } catch { throw new Error(`config: ${where}.base_url is not a URL`); }
    // https only. A plain-http local gateway could be squatted: every agent with a port block may bind
    // loopback ports, so another task's test script could listen there first and take the key (TH-21).
    if (u.protocol !== 'https:') throw new Error(`config: ${where}.base_url must be https`);
    if (u.username || u.password || u.search || u.hash) throw new Error(`config: ${where}.base_url may not carry credentials, a query or a fragment`);
    baseUrl = String(t.base_url).replace(/\/+$/, '');
  }
  const auth = t.auth ?? 'x-api-key';
  if (auth !== 'x-api-key' && auth !== 'bearer') throw new Error(`config: ${where}.auth must be "x-api-key" or "bearer"`);
  let extraBody: Record<string, unknown> | null = null;
  if (t.extra_body !== undefined) {
    if (typeof t.extra_body !== 'object' || t.extra_body === null || Array.isArray(t.extra_body)) throw new Error(`config: ${where}.extra_body must be a table`);
    extraBody = JSON.parse(JSON.stringify(t.extra_body)) as Record<string, unknown>;
    const denied = Object.keys(extraBody).filter((k) => EXTRA_BODY_DENY.includes(k));
    if (denied.length) throw new Error(`config: ${where}.extra_body may not set ${denied.join(', ')}`);
    if (JSON.stringify(extraBody).length > 4096) throw new Error(`config: ${where}.extra_body is over 4 KB`);
  }
  const prices: Record<string, Prices> = {};
  const rawPrices = t.prices ?? {};
  if (typeof rawPrices !== 'object' || rawPrices === null || Array.isArray(rawPrices)) throw new Error(`config: ${where}.prices must be a table`);
  for (const [model, p] of Object.entries(rawPrices as Record<string, unknown>)) {
    if (!MODEL_ID.test(model) || typeof p !== 'object' || p === null) throw new Error(`config: ${where}.prices."${model}" is malformed`);
    const q = p as Record<string, unknown>;
    const price = (k: string, required: boolean) => {
      const v = q[k];
      if (v === undefined && !required) return undefined;
      if (typeof v !== 'number' || !(v >= 0) || v > 1000) throw new Error(`config: ${where}.prices."${model}".${k} must be USD per million tokens, 0 to 1000`);
      return v;
    };
    const cacheRead = price('cache_read', false);
    const cacheWrite = price('cache_write', false);
    prices[model] = { input: price('input', true)!, output: price('output', true)!, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
  }
  if (t.strip_experimental_betas !== undefined && typeof t.strip_experimental_betas !== 'boolean') throw new Error(`config: ${where}.strip_experimental_betas must be true or false`);
  const model = noAlias(text('model', MODEL_ID), `${where}.model`);
  const backgroundModel = t.background_model !== undefined ? noAlias(text('background_model', MODEL_ID), `${where}.background_model`) : baseUrl ? model : null;
  // With prices given, every model the sessions use needs one, or cost (M8) and budgets fall back to a guess.
  for (const m of Object.keys(prices).length ? [model, backgroundModel] : []) {
    if (m && !priceOf(prices, m)) throw new Error(`config: ${where}.prices has no entry for "${m}"`);
  }
  return {
    name,
    baseUrl,
    auth,
    keyEnv: text('key_env', SECRET_NAME),
    model,
    backgroundModel,
    maxContextTokens: num('max_context_tokens', 1000, 10_000_000),
    autoCompactWindow: num('auto_compact_window', 1000, 10_000_000),
    maxOutputTokens: num('max_output_tokens', 1, 1_000_000),
    stripExperimentalBetas: t.strip_experimental_betas === undefined ? baseUrl !== null : t.strip_experimental_betas === true,
    extraBody,
    prices,
  };
}

/**
 * Secret values for the names a task may use: the repo's `env.refs` ∩ this project's local allowlist
 * (D-52), looked up in secrets.toml, which must be owner-only. Names without a value are skipped.
 */
export function resolveSecrets(home: Home, names: string[]): Record<string, string> {
  if (names.length === 0 || !fs.existsSync(home.secrets)) return {};
  const all = parse(readPrivateFile(home.secrets)) as Record<string, unknown>;
  return Object.fromEntries(names.flatMap((n) => (typeof all[n] === 'string' && !isReservedEnvName(n) ? [[n, all[n] as string]] : [])));
}
