# The thin UI's contract, for its Harness tasks (PB4; D-110, D-117)

Every app, style and test file under `packages/ui/**` is written by a Harness task session (PU-1 to PU-6) and lands through its PR. This folder holds what those tasks build against: the layout that keeps six tasks on two Macs out of each other's files, the shared rules, the task texts (`tasks/PU-*.md`), and recorded data (`snapshots/*.json`, generated from the real read model, `ProjectView.snapshot()`). A task reads only the files its text names.

## The layout: one owner per file
| File | Card | What |
|---|---|---|
| `packages/ui/src/uirpc-client.ts` | PU-1 | The NDJSON client for harnessd's socket (`~/.harness/run/harnessd.sock` and the token in `uirpc.token`; protocol.md §12) |
| `packages/ui/src/bridge.ts` | PU-1 | The HTTP server on `127.0.0.1:<ui.port>`: Host and Origin checks, the launch token and the session token, the CSP and headers, static files, and `/api/*` mapped onto `uirpc` |
| `packages/ui/src/main.ts` | PU-1 | `serve` starts the bridge. `open` checks the running bridge with the HMAC challenge (`~/.harness/ui/bridge.secret`) and opens `/launch#t=<token>` |
| `packages/ui/web/api.ts` | PU-1 | The browser's typed client: `startSession`, `snapshot`, `stream` (with reconnect), `health`, `approvals`, `approve`, `deny`, `command`, `dispatch`. It throws `ApiError { status, code, message }` |
| `packages/ui/web/dom.ts` | PU-2 | `el(tag, attrs, ...children)` and `text(s)`. **The only way views make DOM:** strings become text nodes, `on*` attributes are refused, and nothing uses `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` |
| `packages/ui/web/index.html`, `web/app.ts`, `web/styles/app.css` | PU-2 | The shell: session start, the hash router (`#/`, `#/task/<id>`, `#/inbox`, `#/integration`), the connection banner, and each view mounted by its route |
| `packages/ui/web/model/board.ts`, `web/view/board.ts`, `web/styles/board.css` | PU-2 | The board, presence, the new-task form, and the budget line |
| `packages/ui/web/model/task.ts`, `web/view/task.ts`, `web/styles/task.css` | PU-3 | The task detail and its actions |
| `packages/ui/web/model/inbox.ts`, `web/view/inbox.ts`, `web/styles/inbox.css` | PU-4 | Messages and questions, waits and stale-context notices, local approvals, recovery |
| `packages/ui/web/model/integration.ts`, `web/view/integration.ts`, `web/styles/integration.css` | PU-5 | PRs, checks, reviews, the integration and reservation, outside merges, and budget warnings |
| `packages/ui/test/<card>.test.ts` | each card | Its own model's tests, plus PU-1's bridge tests |
| `packages/ui/test/contract.test.ts`, `test/a11y.test.ts`, `test/untrusted.test.ts` | PU-6 | The cross-cutting tests (below) |

**How views are mounted.** Each view exports `mount(root: HTMLElement, ctx: ViewContext): () => void`. It returns its unmount function. A view adds its own stylesheet once, with `el('link', { rel: 'stylesheet', href: './styles/<card>.css' })` (CSP `style-src 'self'`).

**What a view gets.** `ViewContext` is defined by PU-2 in `web/app.ts`:
```ts
{ api, snapshot: () => ProjectSnapshot, onChange(fn): () => void, navigate(route: string): void, toast(msg: string, kind: 'info' | 'error'): void }
```

**Models and views.** Models (`web/model/*.ts`) are pure, with no DOM or `fetch`: snapshot in, plain data out, so they're tested in Node. Views turn a model into DOM through `dom.ts`, and only views touch `api`.

## Rules every task follows
1. **Untrusted text stays text.** That's every string from a task, an agent, a message, the server, GitHub or harnessd. It reaches the page only through `text()` or `el()` children, never as HTML, an attribute name, a URL, a CSS value or an event handler. The only links are the PR and check URLs that `model/integration.ts` builds from `https://github.com/<owner>/<repo>/pull/<number>`, with the number checked to be an integer.
2. **Nothing inline.** No inline `<script>`, `<style>`, `style=` attributes or `on*=` handlers. The CSP forbids them.
3. **Imports.** Browser modules import only relative `./x.ts` paths, and `@harness/*` only as `import type`. Bridge code (`src/`) may import `@harness/daemon` and `@harness/protocol`. No new dependencies.
4. **Credentials.** The session token lives in `sessionStorage` only, and is sent as `Authorization: Bearer`. No cookies and no `localStorage` for tokens. The device key, the `uirpc` token and the bridge secret never reach the browser.
5. **Errors and states.** Every action shows its outcome: success, `ApiError`'s message, or "conflict: reload and look again". Every view handles three cases: the snapshot is missing (still connecting); the connection is `reconnecting`, `server_identity_mismatch` or `coordinator_changed` (the banner explains, and actions are disabled); and an empty list (a sentence, not a blank).
6. **Approvals show what they bind.** An approval's button sends the exact `hash` the human was shown, after showing its full details. For a publish, that's the head and base SHAs, the PR title and body, the held changes and the diffstat. For a dispatch, it's the issuer, the kind, the task and the message. A `conflict` answer means the thing changed: show it again, and never retry blindly.
7. **Dispatches.** Assign, reopen, resume, abandon, complete and integrate go through `api.dispatch(kind, task_id, expected)`. harnessd signs from its own view. `expected` carries what the human saw (for `integrate`: `pr_number`, `head_sha`, `base_sha`). Plain human commands (`task.create` without an assignee, `message.send`, `task.unblock`, `land.cancel`) go through `api.command`, with a fresh `crypto.randomUUID()` as `command_id`. A retry of the same click reuses its id.
8. **Accessibility.**
   - Every control is a real `<button>`, `<input>` or `<select>` with a visible label or `aria-label`, reachable by keyboard in reading order.
   - The connection banner is `role="status" aria-live="polite"`.
   - State is never shown by color alone.

## Snapshots
`snapshots/*.json` are `ProjectSnapshot`s recorded from synthetic event logs through the real `snapshotOf()`. Each file's name says what it shows, for example `stopped-after-restart.json`. Tests read them with `fs.readFileSync`, never `import`, because they live outside the package: `path.join(import.meta.dirname, '../../../test/fixtures/ui-contract/snapshots/<name>.json')`. They're regenerated by `node scripts/pilot/ui-fixtures.ts` whenever the read model changes. A test fails if they drift.
