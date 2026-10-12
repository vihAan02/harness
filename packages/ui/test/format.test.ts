import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCost, shortSha } from '../web/model/format.ts';

test('formatCost shows dollars with three decimals', () => {
  assert.equal(formatCost(0.0123), '$0.012');
  assert.equal(formatCost(0), '$0.000');
  assert.equal(formatCost(1.5), '$1.500');
});

test('shortSha keeps the first 12 characters', () => {
  assert.equal(shortSha('0123456789abcdef0123456789abcdef01234567'), '0123456789ab');
  assert.equal(shortSha('abc'), 'abc');
});
