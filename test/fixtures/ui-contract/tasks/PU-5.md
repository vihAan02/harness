Build the integration and budget page (D-114, D-115, D-116): every task's PR, its checks and reviews, the one integration at a time, merges made outside the harness, and today's spend. Also the one action that merges: Integrate, approving an exact head.

SCOPE: packages/ui/web/model/integration.ts, packages/ui/web/view/integration.ts, packages/ui/web/styles/integration.css, packages/ui/test/integration.test.ts

WAITS FOR: PU-2, integrated and synced. You use `web/dom.ts`, `web/app.ts` and `web/api.ts` as they are.

READ FIRST, and only these:
- test/fixtures/ui-contract/README.md, especially rules 1, 6 and 7.
- packages/ui/web/dom.ts, packages/ui/web/app.ts, packages/ui/web/api.ts.
- packages/protocol/src/index.ts: `PrSnapshot`, `LandSnapshot`, `TaskSnapshot`, `ProjectSnapshot['budget']`, `ProjectSnapshot['base_advances']`.
- docs/protocol.md §11: the integration reservation, `land.request` and `outcome_unknown`.
- test/fixtures/ui-contract/snapshots/.

BUILD:
1. **`web/model/integration.ts`** (pure):
   - **`prUrl(repo, number)`** returns `https://github.com/<owner>/<repo>/pull/<number>`. It's the only link on the page. `repo` must match `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/` and `number` must be a safe positive integer; otherwise there's no link. The repo comes from the PR's own URL host-checked (`https://github.com/`), or not at all.
   - **`integrationModel(snapshot, me)`.** Each task with a PR or a land gives:
     - `pr`: number, state, merged, `mergeable_state`, and the checks, each `{ name, conclusion }`, with `guard`, `unit-linux` and `full-macos` named first;
     - `reviews`: the latest per login, marked current when its `commit_id` equals the head;
     - `land`: mode, status, step and reason, in words;
     - **`integrate`:** `{ allowed, why }`. It's allowed only when all of these hold:
       - `me` is the agent's human;
       - the PR is open;
       - every required check is `success` on the current head;
       - no other land is in flight;
       - the snapshot isn't offline.

       `why` names the first unmet condition, in words.
     - Also returned: `expected: { pr_number, head_sha, base_sha }`, the values the button will approve.
   - **The in-flight land** (at most one per project): its task, step and since-when. `outcome_unknown` gets "GitHub's answer was lost; harnessd is reconciling from GitHub. Don't merge or close this PR by hand."
   - **`base_advances`:** moves of the base made outside the harness, newest first, with the changed paths.
   - **`budgetModel(snapshot)`:**
     - spent today against the daily budget, with the levels `ok` below 80%, `warn` at 80% or more, and `over` at 100% or more;
     - each session's cost against its cap;
     - the words: "New sessions won't start today" at `over`, and "one more session may not fit" when `daily - spent` is less than the session cap.
2. **`web/view/integration.ts`, `mount(root, ctx)`:**
   - **A table of PRs:** the task, a link from `prUrl`, the state, the checks as words plus symbols (never color alone), and the reviews.
   - **The in-flight land, if any,** sits at the top.
   - **Integrate:**
     - First show the exact head and base SHAs in full, and the check states, then a confirm button.
     - It calls `ctx.api.dispatch(project, 'integrate', taskId, expected)`.
     - **A conflict:** "the PR's head or base changed since you looked; review the new head". Re-render, and never retry with new values automatically.
   - **The budget panel,** with the bar's value also written as text.
   - **Outside merges,** in their own list.
3. **`styles/integration.css`:** table styling, and a wide head SHA in monospace that wraps.

TESTS. Write them first. Run only:
- `node --test packages/ui/test/integration.test.ts`
- `node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json`

**`integration.test.ts`** reads the fixtures with `fs.readFileSync` and covers:
- **`prUrl`:** a hostile repo string, a non-integer and a `javascript:` value all give no link; the valid case gives the link;
- **`integrate.allowed`:** false for each unmet condition, one at a time, each with a control where every condition holds;
- **`expected`:** it carries the current head and base;
- **wording:** for `outcome_unknown`, and for the budget at each level and boundary;
- **reviews:** one on an old head is not current.

DONE WHEN: both commands pass, the only links are from `prUrl`, and no file outside SCOPE is changed. Then call `report_done`.
