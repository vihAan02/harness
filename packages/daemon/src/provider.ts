// Which model endpoint harnessd's agents run on, and with which key (D-87). The key is read from
// harnessd's own environment, under the name the local config gives, and passed through untouched
// (D-48): harnessd never logs, stores or forwards it. Errors name the variable, never its value.
import type { Auth, ModelConfig } from '@harness/adapters';
import type { LocalConfig, ProviderConfig } from './config.ts';

export type ResolvedProvider = {
  /** The `[providers.<name>]` used, or null for the vendor's own endpoint and `ANTHROPIC_API_KEY`. */
  name: string | null;
  auth: Auth;
  model: ModelConfig | null;
};

/** The selected provider's name: `HARNESS_PROVIDER` in harnessd's environment, else `agents.provider`. */
export function providerName(config: LocalConfig, env: NodeJS.ProcessEnv): string | null {
  const name = env.HARNESS_PROVIDER || config.agents.provider;
  if (name && !Object.hasOwn(config.providers, name)) throw new Error(`HARNESS_PROVIDER is "${name}", but the config has no [providers.${name}]`);
  return name || null;
}

/** The session model settings for a provider, or for the legacy `agents.model`. */
export function providerModel(config: LocalConfig, name: string | null): ModelConfig | null {
  if (!name) return config.agents.model ? { id: config.agents.model } : null;
  const p = config.providers[name]!;
  return {
    id: p.model,
    ...(p.backgroundModel ? { background: p.backgroundModel } : {}),
    ...(p.maxContextTokens ? { contextTokens: p.maxContextTokens } : {}),
    ...(p.autoCompactWindow ? { compactWindowTokens: p.autoCompactWindow } : {}),
    ...(p.maxOutputTokens ? { maxOutputTokens: p.maxOutputTokens } : {}),
    ...(p.stripExperimentalBetas ? { stripExperimental: true } : {}),
    ...(p.extraBody ? { extraBody: p.extraBody } : {}),
    ...(Object.keys(p.prices).length ? { prices: p.prices } : {}),
  };
}

/** A key must be one printable token: a newline in it could forge a request header. */
const KEY_SHAPE = /^[\x21-\x7e]{8,4096}$/;

export function resolveProvider(config: LocalConfig, env: NodeJS.ProcessEnv = process.env): ResolvedProvider {
  const name = providerName(config, env);
  const model = providerModel(config, name);
  const p: ProviderConfig | null = name ? config.providers[name]! : null;
  const keyEnv = p?.keyEnv ?? 'ANTHROPIC_API_KEY';
  // A project secret with the key's name would hand the key to agents' shells (D-64).
  for (const project of config.projects) {
    if (project.secrets.includes(keyEnv)) throw new Error(`config: projects ${project.id} lists ${keyEnv} as a secret; that variable holds the model key`);
  }
  const apiKey = env[keyEnv];
  if (!apiKey) {
    throw new Error(`set ${keyEnv} in harnessd's environment${name ? ` for the "${name}" provider` : ''}: agents run on an API key, never a subscription login (D-56, D-87)`);
  }
  if (!KEY_SHAPE.test(apiKey)) throw new Error(`${keyEnv} doesn't look like an API key (it must be one printable token)`);
  const auth: Auth = { mode: 'api-key', apiKey, scheme: p?.auth ?? 'x-api-key', ...(p?.baseUrl ? { baseUrl: p.baseUrl } : {}) };
  return { name, auth, model };
}
