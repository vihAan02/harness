// Model providers in harnessd's local config, and how the key is found (D-87). No provider is known to the
// code by name: these tables are what a user writes (README "Choosing a model provider").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventMessage } from '@harness/protocol';
import { computeMetrics, parseConfig, providerModel, ProjectView, renderMetrics, resolveProvider } from '../src/index.ts';

const TOKEN = 't'.repeat(32);
const base = { device_id: 'dev_a', principal: 'human_a' };
const deepseek = {
  base_url: 'https://api.deepseek.com/anthropic', auth: 'x-api-key', key_env: 'DEEPSEEK_API_KEY', model: 'deepseek-flash',
  max_context_tokens: 1_000_000, prices: { 'deepseek-flash': { input: 0.3, output: 1.2, cache_read: 0.006 } },
};
const openrouter = {
  base_url: 'https://openrouter.ai/api', auth: 'bearer', key_env: 'OPENROUTER_API_KEY', model: 'qwen/qwen3.8-27b:free',
  extra_body: { provider: { allow_fallbacks: false } },
};
const cfg = (over: Record<string, unknown> = {}) => parseConfig({ ...base, providers: { deepseek, openrouter }, agents: { provider: 'deepseek', max_budget_usd: 2 }, ...over }, TOKEN);

test('a provider table becomes the session model settings; third-party endpoints default to stripping and a pinned background model', () => {
  const c = cfg();
  assert.equal(c.agents.provider, 'deepseek');
  assert.deepEqual(providerModel(c, 'deepseek'), {
    id: 'deepseek-flash', background: 'deepseek-flash', contextTokens: 1_000_000, stripExperimental: true,
    prices: { 'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 } },
  });
  assert.deepEqual(providerModel(c, 'openrouter')!.extraBody, { provider: { allow_fallbacks: false } });
  // A provider with no base_url is the vendor's own endpoint: nothing stripped, the vendor's background model.
  const anthropic = parseConfig({ ...base, providers: { haiku: { key_env: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5' } } }, TOKEN);
  assert.deepEqual(providerModel(anthropic, 'haiku'), { id: 'claude-haiku-4-5' });
  assert.deepEqual(providerModel(anthropic, null), null, 'no provider and no agents.model: the vendor default');
});

test('the key comes from the variable the provider names, never from the config; errors name it, not its value', () => {
  const c = cfg();
  const p = resolveProvider(c, { DEEPSEEK_API_KEY: 'sk-deepseek-0123456789' });
  assert.deepEqual(p.auth, { mode: 'api-key', apiKey: 'sk-deepseek-0123456789', scheme: 'x-api-key', baseUrl: 'https://api.deepseek.com/anthropic' });
  assert.equal(p.name, 'deepseek');
  assert.throws(() => resolveProvider(c, {}), /set DEEPSEEK_API_KEY in harnessd's environment for the "deepseek" provider/);
  assert.throws(() => resolveProvider(c, { DEEPSEEK_API_KEY: 'bad\nkey-0123456789' }), (e: Error) => /doesn't look like an API key/.test(e.message) && !e.message.includes('bad'));
  const or = resolveProvider(c, { HARNESS_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-0123456789' });
  assert.equal(or.auth.scheme, 'bearer', 'HARNESS_PROVIDER switches provider without editing the file');
  assert.throws(() => resolveProvider(c, { HARNESS_PROVIDER: 'nope' }), /no \[providers.nope\]/);
  // Back-compat: no provider means the vendor's endpoint with ANTHROPIC_API_KEY (D-56).
  const legacy = parseConfig({ ...base, agents: { model: 'claude-haiku-4-5' } }, TOKEN);
  assert.deepEqual(resolveProvider(legacy, { ANTHROPIC_API_KEY: 'sk-ant-api03-0123456789' }), {
    name: null, auth: { mode: 'api-key', apiKey: 'sk-ant-api03-0123456789', scheme: 'x-api-key' }, model: { id: 'claude-haiku-4-5' },
  });
});

test('provider tables are validated strictly: they decide where the key is sent (TH-21)', () => {
  const bad = (p: Record<string, unknown>, re: RegExp) => assert.throws(() => parseConfig({ ...base, providers: { x: { ...deepseek, ...p } } }, TOKEN), re);
  bad({ base_url: 'http://api.example.com' }, /https/);
  bad({ base_url: 'http://127.0.0.1:8080/anthropic' }, /https/); // a local http gateway could be squatted by an agent's test server
  bad({ base_url: 'http://localhost:8080' }, /https/);
  bad({ model: 'sonnet' }, /alias/);
  bad({ background_model: 'other-model' }, /prices has no entry for "other-model"/);
  bad({ base_url: 'https://user:pw@api.example.com' }, /credentials/);
  bad({ base_url: 'https://api.example.com/?key=1' }, /query/);
  bad({ auth: 'cookie' }, /auth/);
  bad({ key_env: 'lower-case' }, /key_env/);
  bad({ model: '--dangerously-skip-permissions' }, /model/);
  bad({ extra_body: { model: 'claude-opus-5-5' } }, /extra_body may not set model/);
  bad({ prices: { 'deepseek-flash': { input: -1, output: 1 } } }, /prices/);
  bad({ temperature: 0 }, /unknown keys: temperature/);
  bad({ strip_experimental_betas: 'yes' }, /true or false/);
  assert.throws(() => parseConfig({ ...base, agents: { provider: 'missing' } }, TOKEN), /no \[providers.missing\]/);
  assert.throws(() => parseConfig({ ...base, agents: { provider: 'constructor' } }, TOKEN), /no \[providers.constructor\]/, 'no prototype lookups');
  assert.throws(() => resolveProvider(parseConfig(base, TOKEN), { HARNESS_PROVIDER: 'toString' }), /no \[providers.toString\]/);
  assert.throws(() => parseConfig({ ...base, agents: { model: 'haiku' } }, TOKEN), /alias/);
  assert.throws(() => parseConfig({ ...base, providers: { deepseek }, agents: { provider: 'deepseek', model: 'x' } }, TOKEN), /not agents.model/);
});

test('project secrets can never take a name the agent CLI reads, or the model key\'s variable (D-87, D-64)', () => {
  for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'NODE_OPTIONS', 'PORT', 'BUN_OPTIONS', 'SSL_KEYLOG_FILE']) {
    assert.throws(() => parseConfig({ ...base, projects: [{ id: 'prj_a', repo: '/r', secrets: [name] }] }, TOKEN), /can't include/, name);
  }
  const c = cfg({ projects: [{ id: 'prj_a', repo: '/r', secrets: ['DEEPSEEK_API_KEY'] }] });
  assert.throws(() => resolveProvider(c, { DEEPSEEK_API_KEY: 'sk-deepseek-0123456789' }), /holds the model key/);
});

test('metrics record the models used and the cost basis, and warn when sessions ran on different models (D-87)', () => {
  const view = new ProjectView('prj_a');
  let seq = 0;
  const ev = (kind: string, data: Record<string, unknown>): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'prj_a', seq: ++seq, at: new Date(1_000_000 + seq).toISOString(), actor: { principal: 'x', on_behalf_of: null, device_id: null }, kind, data });
  view.apply(ev('session.started', { session_id: 's1', agent_id: 'a1', task_id: 't1', device_id: 'd', worktree: '/w', status: 'starting', model: 'deepseek-flash', provider: 'deepseek' }));
  view.apply(ev('usage.reported', { session_id: 's1', input: 100, output: 10, cache_read: 0, cache_creation: 0, cost_usd: 0.00004, cost_basis: 'config', models: ['deepseek-flash'] }));
  let m = computeMetrics(view);
  assert.deepEqual([m.tokens.models, m.tokens.configured, m.tokens.costBasis], [['deepseek-flash'], ['deepseek-flash (deepseek)'], ['config']]);
  assert.doesNotMatch(renderMetrics(m), /different models/);
  view.apply(ev('session.started', { session_id: 's2', agent_id: 'a2', task_id: 't2', device_id: 'd', worktree: '/w2', status: 'starting', model: 'claude-haiku-4-5' }));
  m = computeMetrics(view);
  assert.match(renderMetrics(m), /configured with different models/);
});

test('the example providers in docs/examples/providers.toml are valid config (README "Choosing a model provider")', async () => {
  const { parse } = await import('smol-toml');
  const fs = await import('node:fs');
  const raw = parse(fs.readFileSync(new URL('../../../docs/examples/providers.toml', import.meta.url), 'utf8')) as Record<string, unknown>;
  const c = parseConfig({ ...base, ...raw }, TOKEN);
  assert.deepEqual(Object.keys(c.providers).sort(), ['deepseek', 'haiku', 'kimi', 'openrouter-free']);
  for (const p of Object.values(c.providers)) {
    assert.ok(p.baseUrl === null || p.baseUrl.startsWith('https://'), p.name);
    if (p.baseUrl) assert.ok(p.prices[p.model], `${p.name} prices its model, so M8 and budgets aren't the vendor's guess`);
  }
});
