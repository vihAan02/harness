Create packages/ui/web/model/format.ts: small, pure formatters for the Harness UI, with tests.

- formatCost(usd: number): string, dollars with four decimals: formatCost(0.0123) === '$0.0123'.
- formatDuration(ms: number): string: '45s' under a minute, '3m 05s' under an hour, '1h 02m' from an hour.
- shortSha(sha: string): string: its first 12 characters.

Tests go in packages/ui/test/format.test.ts (node:test and node:assert/strict), importing '../web/model/format.ts'.

Rules:
- format.ts uses no DOM and no Node APIs, and imports nothing.
- Don't edit package.json or any lockfile.
- Before report_done, run and pass:
  npx tsc -p packages/ui/tsconfig.web.json && npx tsc -p packages/ui/tsconfig.test.json && node --test packages/ui/test/format.test.ts
