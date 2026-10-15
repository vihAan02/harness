// The owner's delegation (D-145): what it may decide, where, until when, and for which changes; refused for anything else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Delegation, inScope, isProtected, parseDelegation } from '../src/delegation.ts';
import { tempDir, tempHome } from './fixtures.ts';

const NOW = Date.parse('2026-10-15T06:00:00Z');
const raw = (over: Record<string, unknown> = {}) => ({ devices: ['dev_a'], projects: ['prj_a'], actions: ['publish', 'integrate'], until: '2026-10-22', ...over });

test('a policy names devices, GitHub projects, actions and a near end; anything else is refused', () => {
  const p = parseDelegation(raw(), ['prj_a'], NOW)!;
  assert.deepEqual([p.devices, p.projects, p.actions, p.until, p.maxFiles], [['dev_a'], ['prj_a'], ['integrate', 'publish'], '2026-10-22T00:00:00.000Z', 40]);
  assert.match(p.sha256, /^[0-9a-f]{64}$/);
  assert.equal(parseDelegation(undefined, ['prj_a'], NOW), null);
  assert.throws(() => parseDelegation(raw({ projects: ['prj_local'] }), ['prj_a'], NOW), /isn't a GitHub-mode project/);
  assert.throws(() => parseDelegation(raw({ actions: ['publish', 'setup'] }), ['prj_a'], NOW), /actions must list/);
  assert.throws(() => parseDelegation(raw({ actions: [] }), ['prj_a'], NOW), /actions must list/);
  assert.throws(() => parseDelegation(raw({ until: undefined }), ['prj_a'], NOW), /until must be a date/);
  assert.throws(() => parseDelegation(raw({ until: '2026-12-31' }), ['prj_a'], NOW), /more than 31 days away/);
  assert.throws(() => parseDelegation(raw({ devices: [] }), ['prj_a'], NOW), /devices must list/);
  assert.throws(() => parseDelegation(raw({ reviews: true }), ['prj_a'], NOW), /unknown keys: reviews/);
  assert.throws(() => parseDelegation(raw({ protected: ['../x'] }), ['prj_a'], NOW), /normalized/);
  assert.throws(() => parseDelegation(raw({ max_files: 0 }), ['prj_a'], NOW), /max_files/);
  // The hash names the policy: a change to it is a different policy.
  assert.notEqual(parseDelegation(raw({ max_files: 10 }), ['prj_a'], NOW)!.sha256, p.sha256);
});

test('protected paths and scope: CI, review rules, agent config and manifests always need a click', () => {
  for (const f of ['.github/workflows/ci.yml', 'CODEOWNERS', '.github/CODEOWNERS', 'harness.yaml', 'packages/ui/package.json', 'package-lock.json', 'AGENTS.md', 'docs/CLAUDE.md', '.claude/settings.json', '.mcp.json']) {
    assert.equal(isProtected(f), true, f);
  }
  for (const f of ['packages/ui/web/view/site.ts', 'site/index.html', 'docs/github.md', 'my.github/x']) assert.equal(isProtected(f), false, f);
  assert.equal(isProtected('docs/plan.md', ['docs/']), true);
  assert.equal(isProtected('site/config.ts', ['site/config.ts']), true);
  assert.equal(inScope('packages/ui/web/a.ts', ['packages/ui/']), true);
  assert.equal(inScope('packages/uix/a.ts', ['packages/ui/']), false);
  assert.equal(inScope('README.md', ['README.md', 'site/']), true);
});

test('each decision reads the policy: its device, project and action; turned off, or lapsed, it decides nothing', () => {
  const { dir, cleanup } = tempDir('delegation');
  try {
    const home = tempHome(dir);
    const d = new Delegation(home, 'dev_a', parseDelegation(raw({ actions: ['publish'] }), ['prj_a'], NOW));
    assert.equal(d.refusal('publish', 'prj_a', NOW), null);
    assert.match(d.refusal('integrate', 'prj_a', NOW)!, /integrate isn't in delegation.actions/);
    assert.match(d.refusal('publish', 'prj_b', NOW)!, /prj_b isn't in delegation.projects/);
    assert.match(d.refusal('publish', 'prj_a', Date.parse('2026-10-22T00:00:00Z'))!, /lapsed/);
    assert.match(new Delegation(home, 'dev_b', d.policy).refusal('publish', 'prj_a', NOW)!, /dev_b\) isn't in delegation.devices/);
    assert.match(new Delegation(home, 'dev_a', null).refusal('publish', 'prj_a', NOW)!, /no \[delegation\]/);
    fs.writeFileSync(d.revokedFile, 'now\n');
    assert.match(d.refusal('publish', 'prj_a', NOW)!, /turned off/);

    assert.equal(d.changeRefusal(['packages/ui/a.ts'], ['packages/ui/']), null);
    assert.match(d.changeRefusal(['packages/ui/a.ts', 'packages/cli/b.ts'], ['packages/ui/'])!, /packages\/cli\/b.ts is outside the task's scope/);
    assert.match(d.changeRefusal(['packages/ui/package.json'], ['packages/ui/'])!, /is protected/);
    assert.match(d.changeRefusal(['a.ts'], [])!, /no scope/);
    assert.match(d.changeRefusal(Array.from({ length: 41 }, (_, i) => `s/${i}.ts`), ['s/'])!, /more than delegation.max_files/);

    d.audit({ action: 'publish', project_id: 'prj_a', task_id: 'T-1', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) });
    const line = JSON.parse(fs.readFileSync(path.join(home.logs, 'delegation.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    assert.equal(line.policy_sha256, d.policy!.sha256);
    assert.equal(fs.statSync(path.join(home.logs, 'delegation.jsonl')).mode & 0o077, 0);
  } finally { cleanup(); }
});
