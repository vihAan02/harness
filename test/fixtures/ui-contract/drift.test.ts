// The UI's recorded data stays what scripts/pilot/ui-fixtures.ts builds (PB4): the generator is typed against the real
// ProjectSnapshot, so a contract change breaks `tsc` there, and a stale JSON file breaks this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DerivedTaskState } from '../../../packages/protocol/src/index.ts';
import { fixtures } from '../../../scripts/pilot/ui-fixtures.ts';

test('every fixture file is exactly what the generator builds (regenerate: node scripts/pilot/ui-fixtures.ts)', () => {
  for (const [rel, value] of Object.entries(fixtures())) {
    assert.equal(fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8'), `${JSON.stringify(value, null, 2)}\n`, rel);
  }
});

test('the board fixture has a task in every derived state, and the outcome_unknown one completes the set', () => {
  const all: DerivedTaskState[] = ['open', 'awaiting_approval', 'starting', 'running', 'stopped', 'blocked', 'done', 'publish_pending_approval', 'publishing',
    'publish_blocked', 'pr_open', 'integrating', 'outcome_unknown', 'fetch_pending', 'landed', 'abandoned'];
  const f = fixtures() as Record<string, { tasks: { state: DerivedTaskState }[]; lands: { status: string }[] }>;
  const seen = new Set([...f['snapshots/board.json']!.tasks, ...f['snapshots/outcome-unknown.json']!.tasks].map((t) => t.state));
  assert.deepEqual(all.filter((s) => !seen.has(s)), []);
  for (const name of ['snapshots/board.json', 'snapshots/outcome-unknown.json']) {
    assert.ok(f[name]!.lands.filter((l) => l.status === 'requested' || l.status === 'accepted').length <= 1, `${name}: one integration at a time (D-115)`);
  }
});
