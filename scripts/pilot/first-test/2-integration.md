Make the integration page's costs use the UI's shared cost formatter in packages/ui/web/model/format.ts.

agent/daniyal-ui is about to change that formatter, in the task titled "Rename the cost formatter". So, in this order:
1. Read packages/ui/web/model/format.ts and packages/ui/web/view/integration.ts.
2. Find that task's id with harness_status, call wait_for with kind "task", that id and timeout_s 3600, and end your
   turn.
3. If agent/daniyal-ui asks you a question meanwhile, answer it (with the answer tool, by its question_id), then end
   your turn again. You're still waiting for that task.
4. Only after the harness tells you that task has landed (and what changed in format.ts), make the change below with the
   formatter as it is then.

The change, in packages/ui/web/view/integration.ts only: the three costs that are formatted inline with toFixed(3)
in spendSection (the spent and daily amounts, the session cap, and each task's cost) go through the shared formatter,
imported from '../model/format.ts'. The words around them stay as they are.

Rules:
- Don't edit format.ts, package.json, any lockfile, or any file outside packages/ui/.
- Before report_done, run and pass:
  node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json && node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.test.json && node --test "packages/ui/test/**/*.test.ts"
