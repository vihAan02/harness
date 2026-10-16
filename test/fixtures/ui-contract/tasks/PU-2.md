Build the UI's shell and its board (D-117): what both owners see first. Who's online, every task in its state, a way to write a new task, and how much of today's budget is gone.

SCOPE: packages/ui/web/index.html, packages/ui/web/app.ts, packages/ui/web/dom.ts, packages/ui/web/model/board.ts, packages/ui/web/view/board.ts, packages/ui/web/styles/app.css, packages/ui/web/styles/board.css, packages/ui/test/board.test.ts, packages/ui/test/dom.test.ts

WAITS FOR: PU-1, integrated and synced. You use its `web/api.ts` exactly as it is.

READ FIRST, and only these:
- test/fixtures/ui-contract/README.md: the layout, the rules (all eight bind you) and `ViewContext`.
- packages/ui/web/api.ts: the client you call. Don't change it.
- packages/protocol/src/index.ts: `ProjectSnapshot`, `TaskSnapshot`, `AgentSnapshot`, `DerivedTaskState` and `SnapshotConnection`.
- test/fixtures/ui-contract/snapshots/: the recorded snapshots you test against.

BUILD:
1. **`web/dom.ts`:**
   - `el(tag, attrs, ...children)`:
     - children are `Node | string | null | false`, and a string becomes a text node;
     - `attrs` values are strings or booleans;
     - an attribute name starting with `on`, or named `style`, `srcdoc` or `innerHTML`, throws.
   - `text(s)`, `clear(node)` and `listen(node, event, fn)`. Event handlers are only ever attached through `listen`.
2. **`web/index.html`:**
   - a `<header>` with the title "Harness";
   - a `<div id="banner" role="status" aria-live="polite">`;
   - a `<nav>` with links to `#/`, `#/inbox` and `#/integration`;
   - a `<main id="view">`;
   - `<link rel="stylesheet" href="./styles/app.css">` and `<script type="module" src="./app.ts">`.
   - No inline script or style.
3. **`web/app.ts`:**
   - On `/launch`, `await api.startSession()`, then go to `#/`.
   - Load `api.snapshot()`, then follow `api.stream`, keeping the latest snapshot per project. The project is the first one, unless `?project=` names another.
   - **The router:**
     - `#/` → `view/board.ts`;
     - `#/task/<id>` → `view/task.ts`;
     - `#/inbox` → `view/inbox.ts`;
     - `#/integration` → `view/integration.ts`.

     Import the last three lazily (`import('./view/task.ts')`). Until those files exist, show "This part of the UI isn't built yet".
   - **`ViewContext`** is exactly as the README defines it: `api`, `snapshot()`, `onChange(fn)`, `navigate(route)`, `toast(msg, kind)`.
   - **The banner:**
     - stream reconnecting → "Reconnecting to harnessd…";
     - `connection` is `connecting` or `reconnecting` → "harnessd is reconnecting to the coordinator; actions wait";
     - `server_identity_mismatch` → "The coordinator didn't prove its key. Nothing is trusted. Check the tunnel (harness doctor)";
     - `coordinator_changed` → "A new coordinator database. harnessd won't mix state; see the runbook";
     - a `session_expired` error → "Session ended. Run harness ui again".

     **Whenever the banner shows, actions are disabled:** set `document.body.dataset.offline = 'true'`; views read it.
4. **`web/model/board.ts`** (pure, no DOM):
   - **`boardModel(snapshot)`** returns `{ columns, presence, budget, canCreate }`:
     - `columns` are "Not started" (`open`), "Waiting for approval" (`awaiting_approval`, `publish_pending_approval`), "Working" (`starting`, `running`), "Needs you" (`stopped`, `blocked`, `publish_blocked`, `outcome_unknown`, `fetch_pending`), "In review" (`done`, `publishing`, `pr_open`, `integrating`) and "Landed" (`landed`). `abandoned` is hidden by default.
     - Each card is `{ id, title, state, stateLabel, detail, assignee, deviceLabel, costLabel }`. `stateLabel` is plain words for each `DerivedTaskState`, such as "stopped: the session ended", and `detail` is the snapshot's `state_detail`.
     - `presence` is `{ devices: [{ id, online, mine }], agents: [{ name, human, device, online, busyWith }] }`.
     - `budget` is `{ spent, daily, fraction, level }`, where `level` is `ok` below 80%, `warn` at 80% or more, and `over` at 100% or more.
   - **`newTaskModel(input)`** validates the form:
     - title 1–200 characters;
     - text 1–8000;
     - scope as comma- or newline-separated `folder/` or `file` paths, with no `..`, no leading `/` and no globs other than a trailing `/**`.

     It returns `{ ok: true, args }`, or `{ ok: false, errors: { field: message } }`.
5. **`web/view/board.ts`, `mount(root, ctx)`:**
   - the presence strip;
   - the budget line ("$0.07 of $0.25 today"), with a `warn` or `over` class *and* a word, never color alone;
   - the columns, each card a `<button>` that goes to `#/task/<id>`;
   - **the new-task form:** labelled inputs; on submit, `api.command(project, 'task.create', args, id)`. Keep one `command_id` per click, reused on retry. Show success or the `ApiError` message. Assigning happens on the task page, not here (PU-3).
   - Every list shows a sentence when it's empty.
   - Re-render on `ctx.onChange`. `mount` returns its unmount function.
6. **Styles:**
   - `styles/app.css`: the layout, a readable sans-serif, and focus outlines. It must still work at 360 px wide.
   - `styles/board.css`: the columns, and wrapping on narrow screens.

TESTS. Write them first. Run only:
- `node --test packages/ui/test/board.test.ts packages/ui/test/dom.test.ts`
- `node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json`

**`board.test.ts`** reads each snapshot in `test/fixtures/ui-contract/snapshots/` with `fs.readFileSync` and checks:
- every task lands in exactly one column, matching its state;
- the budget levels at 0, 79%, 80% and 100%;
- presence marks this device as `mine`;
- every `newTaskModel` rule, with valid controls;
- untrusted strings come out unchanged as data. A title `<img src=x onerror=alert(1)>` stays that exact string.

**`dom.test.ts`** uses a minimal fake `document` written in the test: `createElement`, `createTextNode` and `setAttribute`, which record calls. It checks that a string child becomes a text node, never markup, and that `on*`, `style` and `innerHTML` attributes throw.

DONE WHEN: both commands pass, the board renders from every fixture, and no file outside SCOPE is changed. Then call `report_done` with a two-line summary.
