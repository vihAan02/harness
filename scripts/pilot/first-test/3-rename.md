Change the UI's cost formatter in packages/ui/web/model/format.ts: rename formatCost to formatUsd, with a second
parameter for the number of decimals, formatUsd(usd: number, digits = 3): string, so formatUsd(0.5, 2) === '$0.50'.
Update every caller (packages/ui/web/view/board.ts and packages/ui/web/view/task.ts) and
packages/ui/test/format.test.ts to match.

agent/vihaan-ui is about to use this formatter on the integration page (task T-2). Before you change anything:
1. Ask agent/vihaan-ui how many decimals the integration page shows for a cost (the ask tool), then call wait_for with
   kind "answer", the question_id it returned, timeout_s 600, and end your turn.
2. When the answer comes, make the change, keeping digits' default at 3 unless the answer says otherwise. If no answer
   comes before the timeout, make it anyway.

Rules:
- Don't edit package.json, any lockfile, or any file outside packages/ui/, and touch only the files named above.
- Before report_done, run and pass:
  node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json && node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.test.json && node --test "packages/ui/test/**/*.test.ts"
