// The UI's formatters (T-2): a cost shows three decimals with a dollar sign, and a commit id shows its first 12 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsd, shortSha } from '../web/model/format.ts';

test('formatUsd shows dollars with three decimals by default', () => {
  assert.equal(formatUsd(0.0123), '$0.012');
  assert.equal(formatUsd(0), '$0.000');
  assert.equal(formatUsd(1.5), '$1.500');
  assert.equal(formatUsd(12.3456), '$12.346');
});

test('formatUsd takes the number of decimals', () => {
  assert.equal(formatUsd(0.5, 2), '$0.50');
  assert.equal(formatUsd(0.0123, 0), '$0');
});

test('shortSha keeps the first 12 characters', () => {
  assert.equal(shortSha('0123456789abcdef0123456789abcdef01234567'), '0123456789ab');
  assert.equal(shortSha('abc'), 'abc');
  assert.equal(shortSha(''), '');
});
