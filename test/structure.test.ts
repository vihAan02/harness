// Architecture rules from PLAN.md, checked on every test run:
// - product code never imports the throwaway spike (D-44, D-59);
// - agent-vendor SDKs live only in @harness/adapters (D-17, principle 10, R-4);
// - workspace dependencies only point the allowed way (docs/architecture.md §2:
//   the server never runs agents; harnessd reaches vendors only through adapters).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');

/** Which workspace packages each package may depend on. A new package must be added here. */
const ALLOWED: Record<string, string[]> = {
  protocol: [],
  server: ['protocol'],
  adapters: ['protocol'],
  daemon: ['protocol', 'adapters'],
  cli: ['protocol'],
};
const AGENT_VENDOR_SDKS = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', '@openai/codex-sdk', '@openai/codex', 'openai'];

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
const readJson = (p: string): Manifest => JSON.parse(fs.readFileSync(p, 'utf8'));
const depsOf = (m: Manifest) => Object.keys({ ...m.dependencies, ...m.devDependencies, ...m.peerDependencies });
const packageName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2) : spec.split('/').slice(0, 1)).join('/');

const packages = fs.readdirSync(packagesDir).filter((n) => fs.existsSync(path.join(packagesDir, n, 'package.json'))).sort();

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(c|m)?(t|j)sx?$/.test(e.name) ? [p] : [];
  });
}
function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

test('every package is one the architecture names', () => {
  assert.deepEqual(packages, Object.keys(ALLOWED).sort());
});

for (const pkg of packages) {
  const dir = path.join(packagesDir, pkg);
  const declared = depsOf(readJson(path.join(dir, 'package.json')));
  const imports = sourceFiles(dir).flatMap((file) => importsOf(file).map((spec) => ({ file: path.relative(root, file), spec })));

  test(`${pkg}: workspace dependencies point the allowed way`, () => {
    const allowed = (ALLOWED[pkg] ?? []).map((n) => `@harness/${n}`);
    for (const dep of declared.filter((d) => d.startsWith('@harness/'))) assert.ok(allowed.includes(dep), `${pkg} may not depend on ${dep}`);
    for (const { file, spec } of imports.filter((i) => i.spec.startsWith('@harness/'))) {
      const name = packageName(spec);
      assert.ok(allowed.includes(name), `${file} imports ${spec}; ${pkg} may not depend on ${name}`);
      assert.ok(declared.includes(name), `${file} imports ${spec}, which ${pkg}/package.json doesn't declare`);
    }
  });

  test(`${pkg}: agent-vendor SDKs only in adapters`, { skip: pkg === 'adapters' }, () => {
    for (const dep of declared) assert.ok(!AGENT_VENDOR_SDKS.includes(dep), `${pkg} depends on vendor SDK ${dep}`);
    for (const { file, spec } of imports) assert.ok(!AGENT_VENDOR_SDKS.includes(packageName(spec)), `${file} imports vendor SDK ${spec}`);
  });

  test(`${pkg}: relative imports stay inside the package (so never reach spikes/)`, () => {
    for (const { file, spec } of imports.filter((i) => i.spec.startsWith('.'))) {
      const target = path.resolve(root, path.dirname(file), spec);
      assert.ok(target.startsWith(dir + path.sep), `${file} imports ${spec}, outside packages/${pkg}`);
    }
    for (const { file, spec } of imports) assert.ok(!spec.includes('spikes/'), `${file} imports the spike (${spec})`);
  });
}

test('the root package declares no agent-vendor SDK', () => {
  const declared = depsOf(readJson(path.join(root, 'package.json')));
  for (const dep of declared) assert.ok(!AGENT_VENDOR_SDKS.includes(dep), `root depends on vendor SDK ${dep}`);
});
