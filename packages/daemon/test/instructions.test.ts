// What harnessd tells each agent session up front (D-25, D-45), and the agent settings in config.toml.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { renderTask } from '../src/envelope.ts';
import { readRepoInstructions, sessionInstructions, STANDING_INSTRUCTION } from '../src/instructions.ts';
import { tempDir, TOKEN } from './fixtures.ts';

let t: ReturnType<typeof tempDir>;
before(() => { t = tempDir('instr'); });
after(() => t?.cleanup());

test('session instructions carry the standing instruction verbatim, ports, and repo files as labelled context', () => {
  const text = sessionInstructions({ agentName: 'agent/a', taskId: 't1', ports: { base: 3100, count: 10 }, repo: [{ file: 'CLAUDE.md', text: 'Use tabs.' }] });
  assert.ok(text.includes(STANDING_INSTRUCTION));
  assert.match(text, /3100–3109/);
  assert.match(text, /<repo-instructions file="CLAUDE.md">\nUse tabs\.\n<\/repo-instructions>/);
  assert.doesNotMatch(sessionInstructions({ agentName: 'agent/a', taskId: 't1', ports: null, repo: [] }), /ports are/);
});

test('repo instruction files: regular files only, never symlinks or huge files', () => {
  const wt = path.join(t.dir, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(t.dir, 'secret'), 'outside the worktree');
  fs.symlinkSync(path.join(t.dir, 'secret'), path.join(wt, 'CLAUDE.md'));
  fs.writeFileSync(path.join(wt, 'AGENTS.md'), 'x'.repeat(40 * 1024));
  assert.deepEqual(readRepoInstructions(wt), []);
  fs.writeFileSync(path.join(wt, 'AGENTS.md'), 'Be brief.');
  assert.deepEqual(readRepoInstructions(wt), [{ file: 'AGENTS.md', text: 'Be brief.' }]);
});

test('the task arrives in an owner envelope (protocol.md §8)', () => {
  const text = renderTask({ id: 't1', title: 'Add login', text: 'Build POST /login.', scope: ['src/api/', 'src/types.ts'], ownerHumanId: 'human_a' });
  assert.match(text, /^\[harness task\]\nSOURCE: human\/human_a \(local owner\)\nTRUST: owner instruction\nPERMISSIONS: none\n/);
  assert.match(text, /SCOPE: src\/api\/, src\/types\.ts/);
  assert.match(text, /---\nBuild POST \/login\.\n---/);
});

test('config: agent model and budget are optional and validated', () => {
  const base = { device_id: 'dev_a', principal: 'human_a' };
  assert.deepEqual(parseConfig(base, TOKEN).agents, { provider: null, model: null, maxBudgetUsd: null });
  assert.deepEqual(parseConfig({ ...base, agents: { model: 'claude-sonnet-5-5', max_budget_usd: 5 } }, TOKEN).agents, { provider: null, model: 'claude-sonnet-5-5', maxBudgetUsd: 5 });
  assert.throws(() => parseConfig({ ...base, agents: { model: 'bad model; rm -rf' } }, TOKEN), /agents.model/);
  assert.throws(() => parseConfig({ ...base, agents: { max_budget_usd: -1 } }, TOKEN), /max_budget_usd/);
});
