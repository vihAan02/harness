Build the task detail page and its actions (D-117, D-112): everything about one task, and every action its state allows, signed by this Mac's harnessd.

SCOPE: packages/ui/web/model/task.ts, packages/ui/web/view/task.ts, packages/ui/web/styles/task.css, packages/ui/test/task.test.ts

WAITS FOR: PU-2, integrated and synced. You use its `web/dom.ts`, `web/app.ts` (`ViewContext`) and `web/api.ts` exactly as they are.

READ FIRST, and only these:
- test/fixtures/ui-contract/README.md, especially rules 1, 5, 6 and 7.
- packages/ui/web/dom.ts, packages/ui/web/app.ts, packages/ui/web/api.ts.
- packages/protocol/src/index.ts: `TaskSnapshot`, `SessionSnapshot`, `WaitSnapshot`, `LandSnapshot`, `DerivedTaskState`, `DispatchKind`.
- test/fixtures/ui-contract/snapshots/.

BUILD:
1. **`web/model/task.ts`** (pure):
   - **`taskModel(snapshot, taskId)`** returns `null` for an unknown task. Otherwise it returns:
     - `header`: id, title, state, a plain-words label, and detail;
     - `who`: owner, assignee agent and its human, and the device it runs on;
     - `text` and `scope`;
     - `session`: status, started and ended times, end reason, model, cost and tokens;
     - `open_wait`, in words: "waiting for T-4 to land, since 10:02; times out 10:12";
     - `stale_reads`: "files its agent read that changed since";
     - `leases`, with their expiry;
     - `pr` and `land` summaries;
     - `cost`.
   - **`actionsFor(snapshot, taskId, me)`** lists the actions `{ kind, label, needs }`. `me` is the snapshot's `principal`. Only the task's owner or its agent's human gets any action (D-112), and nothing is offered while the banner shows (`document.body.dataset.offline`). By state:
     - `open`: **Assign** (dispatch `start`; needs an agent picked from `snapshot.agents`);
     - `stopped`: **Resume** (dispatch `resume`, with an optional message);
     - `blocked`: **Unblock** (`command task.unblock`), with the text "after you've fixed the conflict in its worktree";
     - `done`, `pr_open` or `publish_blocked`: **Reopen** (dispatch `reopen`; needs a message);
     - `running` and every other state that isn't landed or abandoned: **Abandon** (dispatch `abandon`; needs a reason);
     - `running` or `starting`: **Mark done** (dispatch `complete`).
2. **`web/view/task.ts`, `mount(root, ctx)`.** It reads the task id from the route and renders the model. When the task is unknown, it says "No task T-x in this project".
   - **Each action:**
     - a `<button>` that opens an inline form for any input it needs, with labelled fields;
     - then it calls `ctx.api.dispatch(project, kind, taskId, expected)`, where `expected` is `{ title, scope, text_sha256? }` as the human saw them; or, for unblock, `ctx.api.command(...)`;
     - it shows the outcome: done, the `ApiError` message, or for `conflict`: "the task changed since you looked; it's reloaded, check it again";
     - while it's pending, the button is disabled, so it can't be double-sent. A retry of the same click reuses its `command_id`.
   - **A remote start** (an agent of the other human): say "**name**'s Mac will ask them to approve this start". After a `dispatch.rejected` or `task.start_failed` event, the state comes back `open`; show the reason the snapshot carries.
3. **`styles/task.css`:** sections with headings, and readable monospace for scope and paths.

TESTS. Write them first. Run only:
- `node --test packages/ui/test/task.test.ts`
- `node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json`

**`task.test.ts`** (fixtures read with `fs.readFileSync`) checks:
- `actionsFor` across every state in the fixtures;
- the other human gets no actions unless they own the task;
- nothing is offered when offline;
- the wait and stale-read wording;
- an unknown task gives `null`;
- a task whose title and text hold markup come back unchanged as strings.

DONE WHEN: both commands pass, every action's call matches rule 7, and no file outside SCOPE is changed. Then call `report_done`.
