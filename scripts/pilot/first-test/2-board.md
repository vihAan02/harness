Create packages/ui/web/model/board.ts: group a project's tasks by state for the board view, with tests.

- export function groupByState(tasks: { id: string; title: string; state: string; cost_usd: number }[]):
  Record<string, { id: string; title: string; cost: string }[]>. Each cost shows two decimals, formatted with the
  cost formatter from './format.ts'.

agent/daniyal-ui is about to change that formatter (task T-3). So, in this order:
1. Read packages/ui/web/model/format.ts.
2. Call wait_for with kind "task", id "T-3", timeout_s 3600, and end your turn.
3. If agent/daniyal-ui asks you a question meanwhile, answer it (with the answer tool, by its question_id), then end
   your turn again. You're still waiting for T-3.
4. Only after the harness tells you T-3 has landed (and what changed in format.ts), write board.ts and its test,
   packages/ui/test/board.test.ts (node:test and node:assert/strict).

Rules:
- board.ts imports only './format.ts', and uses no DOM and no Node APIs.
- Don't edit format.ts, package.json or any lockfile.
- Before report_done, run and pass:
  npx tsc -p packages/ui/tsconfig.web.json && npx tsc -p packages/ui/tsconfig.test.json && node --test packages/ui/test/board.test.ts
