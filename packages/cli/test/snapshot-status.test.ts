// `harness status` from harnessd's snapshot (PB3): every state in words, what to do where the human acts, the
// connection's warnings, the budget's levels, and no untrusted string reaching the terminal raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectSnapshot } from '@harness/protocol';
import { renderSnapshot } from '../src/snapshot-status.ts';

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../../test/fixtures/ui-contract/snapshots', `${name}.json`), 'utf8')) as ProjectSnapshot;

test('the board: each task once, in its group, with what to do where the human acts', () => {
  const s = fixture('board');
  const out = renderSnapshot(s, { pendingApprovals: 2 });
  for (const t of s.tasks.filter((x) => !['open', 'landed', 'abandoned'].includes(x.state))) assert.equal(out.split('\n').filter((l) => l.startsWith(`  ${t.id.padEnd(6)} `)).length, 1, t.id);
  assert.match(out, /Needs you: 6/);
  assert.match(out, /T-5 +Approvals panel — stopped: its session ended \(harnessd_restarted\)/);
  assert.match(out, /→ resume it with the work so far: harness task resume T-5/);
  assert.match(out, /→ fix the conflict in its worktree, then: harness task unblock T-6/);
  assert.match(out, /· secret:openrouter_key in notes\.txt/);
  assert.match(out, /waiting for task T-12 since 11 min ago/);
  assert.match(out, /stale: its agent read packages\/ui\/web\/api\.ts, changed since/);
  assert.match(out, /T-11 +Inbox view — PR open[^\n]*\n {9}PR #120: open; guard ✓ success, unit-linux ✓ success, full-macos … pending/, 'a PR follows its own task');
  assert.match(out, /Integration in flight: T-12 \(PR #121\), merge_requested/);
  assert.match(out, /Local approvals waiting on this Mac: 2/);
  assert.match(out, /○ offline dev_daniyal_mac/);
  assert.match(out, /Budget 2026-10-09: \$0\.20 of \$0\.25 on this Mac \(82%\), sessions capped at \$0\.10 — WARNING/);
});

test('connection trouble and budget levels are said in words', () => {
  assert.match(renderSnapshot(fixture('offline')), /^WARN the coordinator did NOT prove its key/m);
  assert.match(renderSnapshot(fixture('reconnecting')), /^WARN reconnecting to the coordinator/m);
  assert.match(renderSnapshot(fixture('budget-over')), /\(104%\).*OVER: new sessions won't start today/);
  assert.match(renderSnapshot(fixture('outcome-unknown')), /→ harnessd is asking GitHub again; don't merge or close the PR by hand/);
  const empty = renderSnapshot(fixture('empty'));
  assert.match(empty, /no agents yet/);
  assert.match(empty, /Needs you: none/);
});

test('untrusted text never reaches the terminal raw: no escapes or control characters', () => {
  const out = renderSnapshot(fixture('hostile'));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(out.replaceAll('\n', '')), 'no control characters but newlines');
  assert.ok(!out.includes('\u001b'), 'no terminal escapes');
  assert.match(out, /<img src=x onerror=alert\(1\)>/, 'shown, as plain text');
});
