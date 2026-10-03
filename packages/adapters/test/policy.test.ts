import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCapabilities, claudeHooks, compileClaudePermissions, editedPaths, hardeningProblems, PINNED, relativize } from '../src/index.ts';
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
  assert.deepEqual(sb.credentials.envVars, [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }]);
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
  assert.deepEqual(seen, [{ kind: 'edit.observed', paths: ['src/a.ts'], outside: [] }]);
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
});

test('capabilities exist only for the verified version (D-49)', () => {
  assert.equal(claudeCapabilities(PINNED.cli).canInjectBetweenTools, true);
  assert.equal(claudeCapabilities(PINNED.cli).hooksFailClosed.postToolUse, false);
  assert.throws(() => claudeCapabilities('9.9.9'), /hasn't been verified/);
});
