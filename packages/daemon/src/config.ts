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
//   [agents]  model = "claude-sonnet-5-5", max_budget_usd = 5   (both optional; the CLI's default model otherwise)
//   [[projects]]  id = "prj_…", repo = "/abs/path", base_branch = "main", secrets = ["DATABASE_URL"]
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { readPrivateFile, type Home } from './home.ts';

export type ProjectConfig = { id: string; repo: string; baseBranch: string; secrets: string[] };
export type LocalConfig = {
  deviceId: string; principal: string; serverUrl: string; token: string;
  projects: ProjectConfig[];
  limits: { maxConcurrentAgents: number; portsPerAgent: number; portRange: [number, number] };
  setup: { allowedDomains: string[]; timeoutSeconds: number };
  agents: { model: string | null; maxBudgetUsd: number | null };
};

/** Linux hands out ephemeral ports from 32768 and macOS from 49152; agent port blocks stay below both (D-68). */
export const EPHEMERAL_FLOOR = 32768;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

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
  if (budget !== undefined && (typeof budget !== 'number' || !(budget > 0) || budget > 1000)) throw new Error('config: agents.max_budget_usd must be a number from 0 to 1000');
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
      secrets: strings(t.secrets, `projects[${i}].secrets`, SECRET_NAME),
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
      model: agents.model === undefined ? null : str(agents.model, 'agents.model', /^[A-Za-z0-9._:@-]{1,100}$/),
      maxBudgetUsd: (budget as number | undefined) ?? null,
    },
  };
}

/**
 * Secret values for the names a task may use: the repo's `env.refs` ∩ this project's local allowlist
 * (D-52), looked up in secrets.toml, which must be owner-only. Names without a value are skipped.
 */
export function resolveSecrets(home: Home, names: string[]): Record<string, string> {
  if (names.length === 0 || !fs.existsSync(home.secrets)) return {};
  const all = parse(readPrivateFile(home.secrets)) as Record<string, unknown>;
  return Object.fromEntries(names.flatMap((n) => (typeof all[n] === 'string' ? [[n, all[n] as string]] : [])));
}
