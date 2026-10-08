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
//
// The two-Mac pilot adds (D-110 to D-117; docs/protocol.md §2, §11, §12):
//   auth = "device-key" | "local-token"   (default "local-token": loopback test and demo stacks)
//   server_key = "ed25519:…"              (device-key: the coordinator's key, pinned out of band, D-111)
//   [trust.devices]  "<device_id>" = { human = "human_…", key = "ed25519:…" }   (who may dispatch here, D-112;
//             pinned out of band, never written from server data; this device's own entry is required)
//   [agents]  daily_budget_usd = 0.25     (device-key: required with max_budget_usd, D-116)
//   [ui]      port = 7480                 (the UI bridge's fixed loopback port, outside limits.port_range, D-117)
//   [[projects]]  integration = "local" | "github"   (default "local"; must match the server's, D-114)
//             remote = "https://github.com/<owner>/<repo>.git"   (github: no userinfo, query or fragment)
//             github_api = "https://api.github.com"   (only HARNESS_TEST=1 may point it, or the remote, elsewhere)
//             commit_name = "…", commit_email = "…@users.noreply.github.com"   (github: who task commits are by)
//             require_dispatch = true   (forced on with device-key or github, D-112)
import fs from 'node:fs';
import path from 'node:path';
import { isModelAlias, isReservedEnvName, MODEL_ID, priceOf, type Prices } from '@harness/adapters';
import type { IntegrationMode } from '@harness/protocol';
import { KeyError, parsePublicKey } from '@harness/protocol/signing';
import { parse, stringify } from 'smol-toml';
import { readPrivateFile, type Home } from './home.ts';

export type ProjectConfig = {
  id: string; repo: string; baseBranch: string; secrets: string[];
  /** D-114. `local` keeps 0B's local land; `github` integrates through PRs. */
  integration: IntegrationMode;
  /** github only: the remote harnessd fetches from and pushes task branches to, and the repo's `owner/name`. */
  remote: string | null; githubRepo: string | null; githubApi: string;
  /** github only: the identity task commits are authored and committed as (the accountable human's, D-114). */
  commitIdentity: { name: string; email: string } | null;
  /** D-112: lifecycle events without a valid dispatch are refused. */
  requireDispatch: boolean;
};
export type AuthScheme = 'device-key' | 'local-token';
export type TrustedDeviceConfig = { humanId: string; key: string };
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
  deviceId: string; principal: string; serverUrl: string;
  /** The local token (local-token only; empty with device-key). */
  token: string;
  auth: AuthScheme;
  /** device-key: the coordinator's pinned public key. */
  serverKey: string | null;
  /** The devices whose dispatches this daemon accepts, with their humans and keys (D-112). */
  trustedDevices: Record<string, TrustedDeviceConfig>;
  ui: { port: number | null };
  projects: ProjectConfig[];
  limits: { maxConcurrentAgents: number; portsPerAgent: number; portRange: [number, number] };
  setup: { allowedDomains: string[]; timeoutSeconds: number };
  agents: { provider: string | null; model: string | null; maxBudgetUsd: number | null; dailyBudgetUsd: number | null; readAllow: string[] };
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
  // With device keys there is no shared token (D-111).
  return parseConfig(raw, raw.auth === 'device-key' ? '' : loadToken(home));
}

function loadToken(home: Home): string {
  const token = process.env.HARNESS_LOCAL_TOKEN ?? (fs.existsSync(home.token) ? readPrivateFile(home.token).trim() : '');
  if (token.length < 32) throw new Error(`no local token: put the server's token (32+ characters) in ${home.token} (chmod 600) or HARNESS_LOCAL_TOKEN`);
  return token;
}

export type ParseOptions = { env?: Record<string, string | undefined> };

const GITHUB_API = 'https://api.github.com';
const ID_TEXT = /^[A-Za-z0-9_-]{1,64}$/;

/** Rejects keys a section doesn't know, so a typo can't silently fall back to local mode or no trust. */
function onlyKeys(t: Record<string, unknown>, known: string[], where: string): void {
  const unknown = Object.keys(t).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`config: ${where} has unknown keys: ${unknown.join(', ')}`);
}

function publicKeyAt(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`config: ${where} must be an "ed25519:…" public key`);
  try {
    parsePublicKey(v);
  } catch (e) {
    if (e instanceof KeyError) throw new Error(`config: ${where}: ${e.message}`);
    throw e;
  }
  return v;
}

/** A GitHub remote: https, no userinfo, query or fragment; its `owner/name`. Elsewhere only under HARNESS_TEST=1 (fake GitHub). */
function githubRemote(v: unknown, where: string, test: boolean): { remote: string; repo: string } {
  let u: URL;
  try { u = new URL(String(v)); } catch { throw new Error(`config: ${where}.remote is not a URL`); }
  if (u.protocol !== 'https:') throw new Error(`config: ${where}.remote must be https`);
  if (u.username || u.password || u.search || u.hash) throw new Error(`config: ${where}.remote may not carry credentials, a query or a fragment`);
  if (u.hostname !== 'github.com' && !test) throw new Error(`config: ${where}.remote must be on github.com`);
  const m = /^\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/.exec(u.pathname);
  if (!m) throw new Error(`config: ${where}.remote must be https://<host>/<owner>/<repo>.git`);
  return { remote: String(v), repo: `${m[1]}/${m[2]}` };
}

export function parseConfig(raw: Record<string, unknown>, token: string, opts: ParseOptions = {}): LocalConfig {
  const test = (opts.env ?? process.env).HARNESS_TEST === '1';
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
  onlyKeys(agents, ['provider', 'model', 'max_budget_usd', 'daily_budget_usd', 'read_allow'], '[agents]');
  const budget = agents.max_budget_usd;
  if (budget !== undefined && (typeof budget !== 'number' || !(budget > 0) || budget > 1000)) throw new Error('config: agents.max_budget_usd must be a number above 0, at most 1000');
  const daily = agents.daily_budget_usd;
  if (daily !== undefined && (typeof daily !== 'number' || !(daily > 0) || daily > 1000)) throw new Error('config: agents.daily_budget_usd must be a number above 0, at most 1000');

  const auth = raw.auth ?? 'local-token';
  if (auth !== 'device-key' && auth !== 'local-token') throw new Error('config: auth must be "device-key" or "local-token"');
  const deviceKey = auth === 'device-key';
  const serverKey = deviceKey ? publicKeyAt(raw.server_key, 'server_key') : null;
  if (!deviceKey && raw.server_key !== undefined) throw new Error('config: server_key is for auth = "device-key"');
  if (deviceKey && (budget === undefined || daily === undefined)) throw new Error('config: auth = "device-key" needs agents.max_budget_usd and agents.daily_budget_usd (D-116)');

  const trust = table(raw.trust);
  onlyKeys(trust, ['devices'], '[trust]');
  const trustedDevices: Record<string, TrustedDeviceConfig> = Object.create(null) as Record<string, TrustedDeviceConfig>;
  for (const [id, v] of Object.entries(table(trust.devices))) {
    if (!ID_TEXT.test(id)) throw new Error(`config: trust.devices has a malformed device id "${id}"`);
    const d = table(v);
    onlyKeys(d, ['human', 'key'], `trust.devices.${id}`);
    if (typeof d.human !== 'string' || !ID_TEXT.test(d.human)) throw new Error(`config: trust.devices.${id}.human is missing or malformed`);
    trustedDevices[id] = { humanId: d.human, key: publicKeyAt(d.key, `trust.devices.${id}.key`) };
  }

  const ui = table(raw.ui);
  onlyKeys(ui, ['port'], '[ui]');
  const uiPort = ui.port === undefined ? null : int(ui.port, 'ui.port', 0, 1024, 65535);
  const providers: Record<string, ProviderConfig> = Object.assign(Object.create(null) as Record<string, ProviderConfig>,
    Object.fromEntries(Object.entries(table(raw.providers)).map(([name, v]) => [name, parseProvider(name, table(v))])));
  const provider = agents.provider === undefined ? null : str(agents.provider, 'agents.provider', PROVIDER_NAME);
  if (provider && !Object.hasOwn(providers, provider)) throw new Error(`config: agents.provider is "${provider}", but there's no [providers.${provider}]`);
  if (provider && agents.model !== undefined) throw new Error('config: set the model in [providers.<name>], not agents.model, when agents.provider is set');
  const serverUrl = str(raw.server_url ?? 'ws://127.0.0.1:7400', 'server_url');
  if (!/^wss?:\/\//.test(serverUrl)) throw new Error('config: server_url must be ws:// or wss://');

  const projects = (Array.isArray(raw.projects) ? raw.projects : []).map((p, i): ProjectConfig => {
    const t = table(p);
    const where = `projects[${i}]`;
    onlyKeys(t, ['id', 'repo', 'base_branch', 'secrets', 'integration', 'remote', 'github_api', 'commit_name', 'commit_email', 'require_dispatch'], where);
    const repo = str(t.repo, `${where}.repo`);
    if (!path.isAbsolute(repo)) throw new Error(`config: ${where}.repo must be an absolute path`);
    const integration = t.integration ?? 'local';
    if (integration !== 'local' && integration !== 'github') throw new Error(`config: ${where}.integration must be "local" or "github"`);
    const github = integration === 'github';
    for (const k of ['remote', 'github_api', 'commit_name', 'commit_email']) {
      if (!github && t[k] !== undefined) throw new Error(`config: ${where}.${k} is for integration = "github"`);
    }
    const remote = github ? githubRemote(t.remote, where, test) : null;
    let githubApi = GITHUB_API;
    if (t.github_api !== undefined) {
      if (!test && t.github_api !== GITHUB_API) throw new Error(`config: ${where}.github_api must be ${GITHUB_API}`);
      githubApi = str(t.github_api, `${where}.github_api`).replace(/\/+$/, '');
    }
    const commitIdentity = github ? {
      name: str(t.commit_name, `${where}.commit_name`, /^[^\u0000-\u001f<>]{1,100}$/),
      email: str(t.commit_email, `${where}.commit_email`, /^[^\s@<>]{1,100}@[^\s@<>]{1,100}$/),
    } : null;
    // D-112: forced on with device keys or GitHub integration; only loopback local-token stacks may leave it off.
    if (t.require_dispatch !== undefined && typeof t.require_dispatch !== 'boolean') throw new Error(`config: ${where}.require_dispatch must be true or false`);
    if (t.require_dispatch === false && (deviceKey || github)) throw new Error(`config: ${where}.require_dispatch can't be false with device keys or GitHub integration (D-112)`);
    return {
      id: str(t.id, `${where}.id`, ID),
      repo: path.resolve(repo),
      baseBranch: str(t.base_branch ?? 'main', `${where}.base_branch`, /^[A-Za-z0-9._/-]{1,200}$/),
      secrets: strings(t.secrets, `${where}.secrets`, SECRET_NAME).map((n) => {
        if (isReservedEnvName(n)) throw new Error(`config: ${where}.secrets can't include ${n}: the agent CLI reads that name (D-87)`);
        return n;
      }),
      integration,
      remote: remote?.remote ?? null,
      githubRepo: remote?.repo ?? null,
      githubApi,
      commitIdentity,
      requireDispatch: deviceKey || github || t.require_dispatch === true,
    };
  });

  const deviceId = str(raw.device_id, 'device_id', ID);
  const principal = str(raw.principal, 'principal', ID);
  if (deviceKey) {
    const own = trustedDevices[deviceId];
    if (!own) throw new Error(`config: trust.devices must pin this device (${deviceId}) too`);
    if (own.humanId !== principal) throw new Error(`config: trust.devices.${deviceId}.human must be this device's principal (${principal})`);
  }
  if (uiPort !== null && uiPort >= start && uiPort <= end) throw new Error('config: ui.port must lie outside limits.port_range (agents may bind those ports)');

  return {
    deviceId,
    principal,
    serverUrl,
    token: deviceKey ? '' : token,
    auth,
    serverKey,
    trustedDevices,
    ui: { port: uiPort },
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
      dailyBudgetUsd: (daily as number | undefined) ?? null,
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
 * Writes a config as TOML after checking it the way harnessd will read it (`harness setup` writes only through this).
 * `token` is only for checking a local-token config; it's never written here (it lives in ~/.harness/token).
 */
export function renderConfig(raw: Record<string, unknown>, opts: ParseOptions & { token?: string } = {}): string {
  parseConfig(raw, opts.token ?? (raw.auth === 'device-key' ? '' : 'x'.repeat(32)), opts);
  return stringify(raw);
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
