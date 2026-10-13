// The UI's formatters (T-2): a cost shows three decimals with a dollar sign, and a commit id shows its first 12 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCost, shortSha } from '../web/model/format.ts';

test('formatCost shows dollars with three decimals', () => {
  assert.equal(formatCost(0.0123), '$0.012');
  assert.equal(formatCost(0), '$0.000');
  assert.equal(formatCost(1.5), '$1.500');
  assert.equal(formatCost(12.3456), '$12.346');
});

test('shortSha keeps the first 12 characters', () => {
  assert.equal(shortSha('0123456789abcdef0123456789abcdef01234567'), '0123456789ab');
  assert.equal(shortSha('abc'), 'abc');
  assert.equal(shortSha(''), '');
});
