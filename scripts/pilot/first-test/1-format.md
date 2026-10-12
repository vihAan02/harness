Give the Harness UI one place for its formatters: create packages/ui/web/model/format.ts, use it where the UI formats a
cost or a commit id today, and test it.

format.ts exports, and nothing else:
- formatCost(usd: number): string: dollars with three decimals, as the UI shows them now: formatCost(0.0123) === '$0.012'.
- shortSha(sha: string): string: its first 12 characters.

Use them, changing nothing else in these files:
- packages/ui/web/view/board.ts and packages/ui/web/view/task.ts: delete each file's local dollars() and call
  formatCost instead.
- packages/ui/web/model/integration.ts: delete its local short() and call shortSha instead.
- packages/ui/web/model/task.ts: the `l.new_base_sha.slice(0, 12)` becomes shortSha(l.new_base_sha).

Tests go in packages/ui/test/format.test.ts (node:test and node:assert/strict), importing '../web/model/format.ts'.

Rules:
- format.ts uses no DOM and no Node APIs, and imports nothing. Browser modules import only relative './x.ts' paths.
- Don't edit package.json, any lockfile, or any file outside packages/ui/.
- Before report_done, run and pass:
  node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json && node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.test.json && node --test "packages/ui/test/**/*.test.ts"
