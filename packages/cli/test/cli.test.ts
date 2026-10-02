import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const main = path.resolve(import.meta.dirname, '../src/main.ts');

test('harness --version runs from source and resolves @harness/protocol', () => {
  const out = execFileSync(process.execPath, [main, '--version'], { encoding: 'utf8' });
  assert.match(out, /^harness 0\.0\.0 \(protocol v1\)\n$/);
});
