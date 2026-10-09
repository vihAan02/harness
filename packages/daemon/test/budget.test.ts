// This device's spend ledger and provider circuit (D-116), and where the model key may come from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MIN_START_USD, ProviderCircuit, SpendLedger, utcDay } from '../src/budget.ts';
import { parseConfig } from '../src/config.ts';
import { resolveProvider } from '../src/provider.ts';
import { tempDir, tempHome, TOKEN } from './fixtures.ts';

const DAY = Date.parse('2026-10-08T12:00:00Z');
const NEXT = Date.parse('2026-10-09T00:00:01Z');

test('the ledger: each session\'s highest running cost, summed by UTC day, kept across restarts', () => {
  const t = tempDir('budget');
  try {
    const home = tempHome(t.dir);
    const l = new SpendLedger(home);
    l.record('s1', 0.02, DAY);
    l.record('s1', 0.05, DAY); // a running total: the latest, highest one counts
    l.record('s1', 0.01, DAY); // never lower
    l.record('s2', 0.1, DAY);
    l.record('s3', Number.NaN, DAY);
    assert.equal(l.spent(DAY).toFixed(2), '0.15');
    assert.equal(new SpendLedger(home).spent(DAY).toFixed(2), '0.15', 'a restart remembers');
    assert.equal(l.spent(NEXT), 0, 'a new UTC day starts from nothing');
    assert.equal(l.remaining(0.25, DAY)!.toFixed(2), '0.10');
    assert.equal(l.remaining(0.1, DAY), 0, 'never negative');
    assert.equal(l.remaining(null, DAY), null);
    assert.equal(utcDay(DAY), '2026-10-08');
    assert.ok(MIN_START_USD > 0);
  } finally { t.cleanup(); }
});

test('the circuit: auth and billing stay open until reset; budget closes on the next UTC day; the first reason stands', () => {
  const t = tempDir('circuit');
  try {
    const home = tempHome(t.dir);
    const c = new ProviderCircuit(home);
    assert.equal(c.state(DAY), null);
    c.open('billing', 'credit balance too low', DAY);
    c.open('auth', 'later', DAY);
    assert.deepEqual([c.state(DAY)!.kind, c.state(DAY)!.reason], ['billing', 'credit balance too low']);
    assert.equal(new ProviderCircuit(home).state(NEXT)!.kind, 'billing', 'still open the next day, and after a restart');
    c.reset();
    assert.equal(c.state(DAY), null);
    c.open('budget', '$0.25 spent of $0.25', DAY);
    assert.equal(c.state(DAY)!.kind, 'budget');
    assert.equal(c.state(NEXT), null, 'closes on the next UTC day');
    assert.ok(!fs.existsSync(c.file));
  } finally { t.cleanup(); }
});

test('the model key: harnessd\'s environment first, else secrets.toml (owner-only), never a project secret', () => {
  const t = tempDir('provider-key');
  try {
    const home = tempHome(t.dir);
    const config = parseConfig({
      device_id: 'dev_a', principal: 'human_a',
      providers: { or: { base_url: 'https://openrouter.ai/api', auth: 'bearer', key_env: 'OPENROUTER_API_KEY', model: 'deepseek/deepseek-v4.1-flash' } },
      agents: { provider: 'or' }, projects: [],
    }, TOKEN);
    assert.throws(() => resolveProvider(config, {}, home.secrets), /OPENROUTER_API_KEY .*or in ~\/\.harness\/secrets\.toml/);
    fs.writeFileSync(home.secrets, 'OPENROUTER_API_KEY = "sk-or-from-secrets-file-0123456789"\n', { mode: 0o600 });
    assert.equal((resolveProvider(config, {}, home.secrets).auth as { apiKey: string }).apiKey, 'sk-or-from-secrets-file-0123456789');
    assert.equal((resolveProvider(config, { OPENROUTER_API_KEY: 'sk-or-from-env-0123456789' }, home.secrets).auth as { apiKey: string }).apiKey, 'sk-or-from-env-0123456789', 'the environment wins');
    fs.chmodSync(home.secrets, 0o644);
    assert.throws(() => resolveProvider(config, {}, home.secrets), /must not be readable by others/);
    const leaky = parseConfig({
      device_id: 'dev_a', principal: 'human_a', agents: { provider: 'or' },
      providers: { or: { base_url: 'https://openrouter.ai/api', auth: 'bearer', key_env: 'OPENROUTER_API_KEY', model: 'deepseek/deepseek-v4.1-flash' } },
      projects: [{ id: 'prj_a', repo: '/r', secrets: ['OPENROUTER_API_KEY'] }],
    }, TOKEN);
    assert.throws(() => resolveProvider(leaky, { OPENROUTER_API_KEY: 'sk-or-from-env-0123456789' }), /lists OPENROUTER_API_KEY as a secret/);
  } finally { t.cleanup(); }
});
