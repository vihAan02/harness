Change the cost formatter in packages/ui/web/model/format.ts: rename formatCost to formatUsd, with a second parameter
for the number of decimals, formatUsd(usd: number, digits = 4): string, so formatUsd(0.5, 2) === '$0.50'. Update
packages/ui/test/format.test.ts to match.

agent/vihaan-ui is building a board on this formatter (task T-2). Before you change anything:
1. Ask agent/vihaan-ui how many decimals the board shows (the ask tool), then call wait_for with kind "answer", the
   question_id it returned, timeout_s 600, and end your turn.
2. When the answer comes, make the change. If no answer comes before the timeout, make it anyway.

Rules:
- Don't edit package.json or any lockfile, and don't touch other files under packages/ui/.
- Before report_done, run and pass:
  npx tsc -p packages/ui/tsconfig.web.json && npx tsc -p packages/ui/tsconfig.test.json && node --test packages/ui/test/format.test.ts
