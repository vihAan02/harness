import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSessionInputs, claudeCapabilities, claudeHooks, compileClaudePermissions, editedPaths, hardeningProblems, isReservedEnvName, PINNED, relativize,
  sessionCost, sessionEnv, vendorBudget,
} from '../src/index.ts';
import type { Observation } from '../src/adapter.ts';

const WT = '/h/worktrees/prj/t1';
const GIT = '/h/repo/.git';
const tools = [{ name: 'ask', description: '', params: {}, run: async () => ({ text: '' }) }];

test('compilePermissions: path-scoped writes, never bare Edit/Write (D-60)', () => {
  const p = compileClaudePermissions({ worktree: WT, gitCommonDir: GIT, ports: null, tools });
  assert.equal(p.permissionMode, 'dontAsk');
  assert.deepEqual(p.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  assert.ok(p.allowedTools?.includes(`Edit(/${WT}/**)`));
  assert.ok(p.allowedTools?.includes(`Write(/${WT}/**)`));
  assert.ok(!p.allowedTools?.includes('Edit') && !p.allowedTools?.includes('Write'));
  assert.ok(p.allowedTools?.includes('mcp__harness__ask'));
  assert.deepEqual(p.disallowedTools, ['SendMessage', 'ListAgents']);
  assert.deepEqual(p.settingSources, []);
});

test('compilePermissions: sandbox on, no escape, shared .git and the auth variable denied (D-60, D-64)', () => {
  const p = compileClaudePermissions({ worktree: WT, gitCommonDir: GIT, ports: null, tools: [] });
  const sb = p.sandbox as Record<string, any>;
  assert.equal(sb.enabled, true);
  assert.equal(sb.failIfUnavailable, true);
  assert.equal(sb.allowUnsandboxedCommands, false);
  for (const x of ['refs', 'objects', 'hooks', 'config', 'HEAD', 'index', 'worktrees']) assert.ok(sb.filesystem.denyWrite.includes(`${GIT}/${x}`), x);
  assert.deepEqual(sb.credentials.envVars, [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }, { name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }], 'every auth variable, whichever a session uses (D-64, D-87)');
  assert.equal(sb.network, undefined, 'no loopback binding without ports');
  const s = p.settings as Record<string, any>;
  assert.equal(s.bashEditDiffEnabled, true);
  assert.equal(s.crossSessionInbound, 'refuse');
  const withPorts = compileClaudePermissions({ worktree: WT, gitCommonDir: GIT, ports: { base: 3100, count: 10 }, tools: [] });
  assert.equal((withPorts.sandbox as Record<string, any>).network.allowLocalBinding, true); // D-68
});

test('compilePermissions refuses relative or unnormalized paths', () => {
  assert.throws(() => compileClaudePermissions({ worktree: 'wt', gitCommonDir: GIT, ports: null, tools: [] }));
  assert.throws(() => compileClaudePermissions({ worktree: '/a/../b', gitCommonDir: GIT, ports: null, tools: [] }));
});

test('editedPaths reads file tools and bashEditDiff (SP-03)', () => {
  assert.deepEqual(editedPaths({ tool_name: 'Write', tool_input: { file_path: `${WT}/a.ts` } }), [`${WT}/a.ts`]);
  assert.deepEqual(editedPaths({ tool_name: 'Edit', tool_input: { file_path: `${WT}/b.ts` } }), [`${WT}/b.ts`]);
  assert.deepEqual(editedPaths({
    tool_name: 'Bash', tool_input: { command: 'sed -i …' },
    tool_response: { bashEditDiff: { files: [{ filePath: `${WT}/c.ts` }], changedFiles: [`${WT}/d.ts`] } },
  }), [`${WT}/c.ts`, `${WT}/d.ts`]);
  assert.deepEqual(editedPaths({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} }), []);
  assert.deepEqual(editedPaths({ tool_name: 'Read', tool_input: { file_path: `${WT}/a.ts` } }), []);
});

test('relativize separates the worktree from everything else', () => {
  assert.deepEqual(relativize(WT, [`${WT}/src/a.ts`, `${WT}/../t2/x.ts`, '/etc/passwd', `${WT}/src/a.ts`]),
    { paths: ['src/a.ts'], outside: ['/etc/passwd', '/h/worktrees/prj/t2/x.ts'] });
});

test('dead-man PreToolUse: denies writes outside the worktree, and denies when its own body throws (D-62)', async () => {
  const hooks = claudeHooks({ worktree: WT }, { observe: () => {} });
  const pre = hooks.PreToolUse![0]!;
  assert.equal(pre.timeout, 5);
  const call = (input: unknown) => pre.hooks[0]!(input as never, undefined, { signal: new AbortController().signal });
  assert.deepEqual(await call({ tool_name: 'Write', tool_input: { file_path: `${WT}/ok.ts` } }), {});
  const outside = await call({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }) as Record<string, any>;
  assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny');
  const hostile = { get tool_name(): string { throw new Error('boom'); } };
  const thrown = await call(hostile) as Record<string, any>;
  assert.equal(thrown.hookSpecificOutput.permissionDecision, 'deny');
});

test('PostToolUse reports edits as worktree-relative paths, and never throws', async () => {
  const seen: Observation[] = [];
  const hooks = claudeHooks({ worktree: WT }, { observe: (o) => seen.push(o) });
  const post = hooks.PostToolUse![0]!.hooks[0]!;
  const opts = { signal: new AbortController().signal };
  await post({ tool_name: 'Write', tool_input: { file_path: `${WT}/src/a.ts` } } as never, undefined, opts);
  await post({ tool_name: 'Read', tool_input: { file_path: `${WT}/src/a.ts` } } as never, undefined, opts);
  assert.deepEqual(await post({ get tool_name(): string { throw new Error('boom'); } } as never, undefined, opts), {});
  assert.deepEqual(seen.filter((o) => o.kind === 'edit.observed'), [{ kind: 'edit.observed', paths: ['src/a.ts'], outside: [] }]);
});

test('PostToolUse: every call it sees is reported for the missed-hook monitor, and reads are captured (0B item 1)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hooks-')));
  fs.mkdirSync(path.join(wt, 'src'));
  for (const f of ['src/a.ts', 'src/b.ts', 'src/c.ts']) fs.writeFileSync(path.join(wt, f), 'x\n');
  const seen: Observation[] = [];
  const hooks = claudeHooks({ worktree: wt }, { observe: (o) => seen.push(o) });
  const post = hooks.PostToolUse![0]!.hooks[0]!;
  const fail = hooks.PostToolUseFailure![0]!.hooks[0]!;
  const opts = { signal: new AbortController().signal };
  await post({ tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: `${wt}/src/a.ts`, offset: 10, limit: 20 } } as never, undefined, opts);
  await post({ tool_name: 'Read', tool_use_id: 'r2', tool_input: { file_path: '/etc/hosts' } } as never, undefined, opts);
  await post({ tool_name: 'Grep', tool_use_id: 'g1', tool_input: { pattern: 'x' }, tool_response: { mode: 'files_with_matches', filenames: [`${wt}/src/a.ts`, 'src/b.ts'] } } as never, undefined, opts);
  await post({ tool_name: 'Grep', tool_use_id: 'g2', tool_input: { pattern: 'x', output_mode: 'content' }, tool_response: { mode: 'content', filenames: [], content: 'src/c.ts:1:x\nnot-a-file:2:x\nsrc/c.ts-2-ctx' } } as never, undefined, opts);
  await post({ tool_name: 'Glob', tool_use_id: 'gl', tool_input: { pattern: '**' }, tool_response: { filenames: ['src/a.ts'] } } as never, undefined, opts);
  await post({ tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'cat src/a.ts' }, tool_response: {} } as never, undefined, opts);
  await fail({ tool_name: 'Read', tool_use_id: 'f1', tool_input: { file_path: `${wt}/nope` }, error: 'missing' } as never, undefined, opts);
  assert.deepEqual(seen.filter((o) => o.kind === 'hook.seen').map((o) => [o.toolUseId, o.event]), [['r1', 'post'], ['r2', 'post'], ['g1', 'post'], ['g2', 'post'], ['gl', 'post'], ['b1', 'post'], ['f1', 'post_failure']]);
  const reads = seen.filter((o) => o.kind === 'read.observed');
  assert.deepEqual(reads.map((o) => [o.toolUseId, o.reads.map((r) => [r.path, r.source, r.confidence, r.range?.start ?? null, r.range?.lines ?? null]), o.outside]), [
    ['r1', [['src/a.ts', 'read_tool', 'high', 10, 20]], []],
    ['r2', [], ['/etc/hosts']],
    ['g1', [['src/a.ts', 'search_hit', 'medium', null, null], ['src/b.ts', 'search_hit', 'medium', null, null]], []],
    ['g2', [['src/c.ts', 'search_hit', 'medium', null, null]], []],
  ], 'Glob names files without reading them; text that isn\'t a real file is dropped');
  assert.deepEqual(seen.filter((o) => o.kind === 'shell.ran'), [{ kind: 'shell.ran', toolUseId: 'b1', command: 'cat src/a.ts' }]);
  fs.rmSync(wt, { recursive: true, force: true });
});

test('hardeningProblems flags anything the session config should have ruled out', () => {
  const good = {
    claude_code_version: PINNED.cli, apiKeySource: 'ANTHROPIC_API_KEY', permissionMode: 'dontAsk', cwd: WT,
    tools: ['Read', 'Bash', 'mcp__harness__ask'], mcp_servers: [{ name: 'harness', status: 'connected' }], plugins: [],
  };
  assert.deepEqual(hardeningProblems(good, { worktree: WT, tools }), []);
  const bad = { ...good, claude_code_version: '2.1.300', apiKeySource: 'none', permissionMode: 'auto', cwd: '/elsewhere',
    tools: [...good.tools, 'WebFetch'], mcp_servers: [...good.mcp_servers, { name: 'repo-server', status: 'connected' }], plugins: [{}] };
  assert.equal(hardeningProblems(bad, { worktree: WT, tools }).length, 7);
  // D-87: a configured model must be the one the CLI runs; a bearer-only login reports 'none' and fails (C-21).
  assert.deepEqual(hardeningProblems({ ...good, model: 'deepseek-flash' }, { worktree: WT, tools, model: { id: 'deepseek-flash' } }), []);
  assert.match(hardeningProblems({ ...good, model: 'claude-opus-5-5' }, { worktree: WT, tools, model: { id: 'deepseek-flash' } }).join(), /not the configured deepseek-flash/);
  assert.match(hardeningProblems({ ...good, apiKeySource: 'none' }, { worktree: WT, tools }).join(), /not the API key/);
});

const KEY = 'k-0123456789';
const envOf = (over: Partial<Parameters<typeof sessionEnv>[0]> = {}) =>
  sessionEnv({ env: { PORT: '3100' }, secrets: {}, auth: { mode: 'api-key', apiKey: KEY }, configDir: '/cfg', ...over });

test('session env: the vendor default endpoint gets the key as an API key, and nothing else (D-56)', () => {
  const env = envOf();
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined, 'no model configured: the vendor picks its own');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(env.PORT, '3100');
});

test('session env: a bearer provider gets the key in both auth variables, so the auth-source check still holds (D-87, C-21)', () => {
  const env = envOf({ auth: { mode: 'api-key', apiKey: KEY, scheme: 'bearer', baseUrl: 'https://gw.example/api' } });
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gw.example/api');
});

test('session env: a configured model pins every alias, and maps its limits and request settings (F-25, F-26, F-29)', () => {
  const env = envOf({ model: { id: 'deepseek-flash', background: 'deepseek-flash', stripExperimental: true, contextTokens: 1_000_000, compactWindowTokens: 200_000, maxOutputTokens: 32_000, extraBody: { provider: { allow_fallbacks: false } } } });
  for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[k], 'deepseek-flash', k);
  assert.equal(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000');
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '32000');
  assert.deepEqual(JSON.parse(env.CLAUDE_CODE_EXTRA_BODY!), { provider: { allow_fallbacks: false } });
  assert.equal(envOf({ model: { id: 'claude-haiku-4-5' } }).ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined, 'no background model: the vendor keeps its own');
});

test('session env: harness-set values win over secrets, and secrets may never use a reserved name (D-87, TH-21)', () => {
  const env = envOf({ secrets: { DATABASE_URL: 'postgres://x' } });
  assert.equal(env.DATABASE_URL, 'postgres://x');
  for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'anthropic_custom_headers', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTPS_PROXY', 'https_proxy', 'NODE_OPTIONS', 'PORT', 'HARNESS_PORT_BASE', 'PATH', 'DYLD_INSERT_LIBRARIES',
    // The CLI is a Bun binary: BUN_OPTIONS can preload a file into it, BUN_CONFIG_VERBOSE_FETCH prints the key (F-78).
    'BUN_OPTIONS', 'BUN_CONFIG_VERBOSE_FETCH', 'BUN_INSPECT', 'SSL_KEYLOG_FILE', 'SSL_CERT_FILE']) {
    assert.ok(isReservedEnvName(name), name);
    assert.throws(() => checkSessionInputs({ secrets: { [name]: 'x' }, auth: { mode: 'api-key', apiKey: KEY } }), /may not set/, name);
  }
  for (const name of ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'GITHUB_TOKEN']) assert.ok(!isReservedEnvName(name), name);
});

test('session inputs: model ids and endpoints are checked before the CLI sees them (D-87)', () => {
  const ok = { secrets: {}, auth: { mode: 'api-key' as const, apiKey: KEY } };
  for (const id of ['deepseek-flash', 'deepseek-flash[1m]', 'qwen/qwen3.8-27b:free', 'kimi-k2.6', 'claude-haiku-4-5']) checkSessionInputs({ ...ok, model: { id } });
  for (const id of ['--dangerously-skip-permissions', '-x', 'a b', 'x;y', '']) assert.throws(() => checkSessionInputs({ ...ok, model: { id } }), /malformed/, id);
  for (const id of ['sonnet', 'opus', 'haiku', 'default', 'opusplan', 'sonnet[1m]']) assert.throws(() => checkSessionInputs({ ...ok, model: { id } }), /alias/, id);
  // http only to the literal IPv4 loopback, for test doubles; never localhost, which also resolves to [::1] (TH-21).
  for (const baseUrl of ['https://api.example.com/anthropic', 'http://127.0.0.1:9999']) checkSessionInputs({ ...ok, auth: { ...ok.auth, baseUrl } });
  for (const baseUrl of ['http://api.example.com', 'http://localhost:1', 'http://[::1]:1', 'https://user:pw@api.example.com', 'https://api.example.com/?k=1', 'ftp://x']) {
    assert.throws(() => checkSessionInputs({ ...ok, auth: { ...ok.auth, baseUrl } }), /https/, baseUrl);
  }
});

test('cost: configured prices win when every model has them; otherwise the vendor figure and its basis (F-27)', () => {
  const t = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreation: 0, vendorCostUsd: 7.5, vendorBasis: 'unknown' as const };
  assert.deepEqual(sessionCost({ 'deepseek-flash': t }, { 'deepseek-flash': { input: 0.3, output: 1.2 } }), { costUsd: 0.42, costBasis: 'config' });
  assert.deepEqual(sessionCost({ 'deepseek-flash[1m]': t }, { 'deepseek-flash': { input: 0.3, output: 1.2 } }), { costUsd: 0.42, costBasis: 'config' }, 'a [1m] id uses the bare id\'s prices');
  assert.deepEqual(sessionCost({ 'deepseek-flash': t }), { costUsd: 7.5, costBasis: 'unknown' });
  assert.deepEqual(sessionCost({ 'claude-haiku-4-5': { ...t, vendorCostUsd: 1.5, vendorBasis: 'list' } }), { costUsd: 1.5, costBasis: 'list' });
  // Partly priced: the priced model at configured prices, the rest at the vendor's figure, and the basis says which.
  assert.deepEqual(sessionCost({ 'deepseek-flash': t, 'other-model': { ...t, vendorCostUsd: 1 } }, { 'deepseek-flash': { input: 0.3, output: 1.2 } }), { costUsd: 1.42, costBasis: 'unknown' });
  // The CLI's own cap guesses $5/$25 per 1M (cache $0.50/$6.25) for unknown models, so it's scaled up to never trip before the real budget.
  assert.equal(vendorBudget(2, { id: 'deepseek-flash', prices: { 'deepseek-flash': { input: 0.3, output: 1.2 } } }), 41.67);
  assert.equal(vendorBudget(1, { id: 'deepseek-flash', prices: { 'deepseek-flash': { input: 0.3, output: 1.2, cacheRead: 0.006 } } }), 83.34, 'cheap cache reads scale it further');
  assert.equal(vendorBudget(2, { id: 'free:model', prices: { 'free:model': { input: 0, output: 0 } } }), 1000, 'a free model: the CLI cap is moved out of the way');
  assert.ok(vendorBudget(0.004, { id: 'x', prices: { x: { input: 5, output: 25 } } }) >= 0.01, 'never rounded down to a $0 cap');
  assert.equal(vendorBudget(2, { id: 'claude-haiku-4-5' }), 2);
});

test('capabilities exist only for the verified version (D-49)', () => {
  assert.equal(claudeCapabilities(PINNED.cli).canInjectBetweenTools, true);
  assert.equal(claudeCapabilities(PINNED.cli).hooksFailClosed.postToolUse, false);
  assert.throws(() => claudeCapabilities('9.9.9'), /hasn't been verified/);
});
