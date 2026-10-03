import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createWorktree } from '../src/git.ts';
import { killOrphans, processStart, Sessions, type SessionRecord } from '../src/supervision.ts';
import { makeRepo, tempDir, tempHome } from './fixtures.ts';

let t: ReturnType<typeof tempDir>;
before(() => { t = tempDir('supervision'); });
after(() => t?.cleanup());

const sleeper = () => {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid!;
};

test('an orphan from a previous run is killed, and its task\'s edits are reconciled from the worktree', async () => {
  const home = tempHome(path.join(t.dir, 'h1'));
  const { repo, sha } = makeRepo(path.join(t.dir, 'r1'), { 'a.ts': 'a\n' });
  const wt = path.join(home.worktrees, 'prj', 'task-1');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  await createWorktree(repo, wt, 'task-1', sha);
  fs.writeFileSync(path.join(wt, 'a.ts'), 'edited by the orphan\n'); // an edit no hook saw (D-70)

  const pid = sleeper();
  const sessions = new Sessions(home);
  const rec: SessionRecord = { sessionId: 's1', agentId: 'agent_a', taskId: 'task-1', projectId: 'prj', worktree: wt, baseBranch: 'main',
    pid, pidStart: await processStart(pid), configDir: '/x', startedAt: new Date().toISOString() };
  sessions.save(rec);

  assert.deepEqual(await killOrphans(sessions), [{ sessionId: 's1', taskId: 'task-1', projectId: 'prj', pid, changedPaths: ['a.ts'] }]);
  assert.equal(await processStart(pid), null, 'the orphan is still running');
  const after = sessions.list()[0]!;
  assert.equal(after.pid, null);
  assert.match(after.endReason!, /orphan killed/);
  assert.deepEqual(await killOrphans(sessions), [], 'a second start finds nothing to do');
});

test('a reused PID (same number, different start time) is never killed', async () => {
  const home = tempHome(path.join(t.dir, 'h2'));
  const pid = sleeper();
  const sessions = new Sessions(home);
  sessions.save({ sessionId: 's2', agentId: 'agent_a', taskId: 't', projectId: 'prj', worktree: '/nonexistent', baseBranch: 'main',
    pid, pidStart: 'Mon Jan  1 00:00:00 2001', configDir: '/x', startedAt: new Date().toISOString() });
  try {
    assert.deepEqual(await killOrphans(sessions), []);
    assert.ok(await processStart(pid), 'an unrelated process was killed');
    assert.match(sessions.list()[0]!.endReason!, /process gone/);
  } finally {
    process.kill(pid, 'SIGKILL');
  }
});
