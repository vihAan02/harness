// The shim's tool-input schemas (protocol.md §6): short strings, string lists, and whole numbers within bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paramSchema } from '../src/claude/shim.ts';

test('a number parameter takes whole numbers within its bounds; strings and lists keep their limits', () => {
  const ttl = paramSchema({ type: 'number', description: 'seconds', min: 10, max: 3600 });
  assert.equal(ttl.safeParse(120).success, true);
  for (const bad of [9, 3601, 1.5, '120', null]) assert.equal(ttl.safeParse(bad).success, false, `rejects ${JSON.stringify(bad)}`);
  const optional = paramSchema({ type: 'number', description: 'seconds', optional: true });
  assert.equal(optional.safeParse(undefined).success, true);
  assert.equal(optional.safeParse(-5).success, true, 'no bounds unless given');
  const text = paramSchema({ type: 'string', description: 't', maxLength: 3 });
  assert.deepEqual([text.safeParse('abc').success, text.safeParse('abcd').success, text.safeParse(3).success], [true, false, false]);
  const list = paramSchema({ type: 'string[]', description: 'paths' });
  assert.deepEqual([list.safeParse(['a', 'b']).success, list.safeParse(Array(101).fill('a')).success, list.safeParse('a').success], [true, false, false]);
});
