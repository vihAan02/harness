Test the whole thin UI, then fix what the tests find (D-117). You're the last UI task. Make the contract, the untrusted-text rule and accessibility hold across every view, so a change that breaks them fails a test.

SCOPE: packages/ui/test/contract.test.ts, packages/ui/test/untrusted.test.ts, packages/ui/test/a11y.test.ts, packages/ui/test/support.ts, packages/ui/web/

WAITS FOR: PU-1, PU-3, PU-4 and PU-5, each integrated and synced.

READ FIRST, and only these:
- test/fixtures/ui-contract/README.md: you're checking every one of its rules.
- every file under packages/ui/web/;
- packages/ui/test/*.test.ts, to reuse their stubs rather than writing new ones;
- test/fixtures/ui-contract/snapshots/ and test/fixtures/ui-contract/approvals.json.

BUILD:
1. **`packages/ui/test/support.ts`.** A minimal fake DOM, in plain TypeScript with no dependency:
   - `document.createElement` and `createTextNode`;
   - elements with `setAttribute`, `appendChild`, `replaceChildren`, `addEventListener`, `children` and `textContent`, plus `querySelectorAll` by tag name, attribute and class;
   - a `ViewContext` stub with a scripted `api` that records every call.

   Install it on `globalThis` for a test, and remove it after.
2. **`contract.test.ts`.** Mount each view (board, task, inbox, integration) against every snapshot fixture with the fake DOM, and check:
   - **it doesn't throw**, and an empty project shows its sentences;
   - **each action calls `api` exactly as rule 7 says.** Dispatch kinds go through `dispatch`, with `expected` taken from what was rendered. Commands go through `command`, with a UUID `command_id` that is reused on a retry of the same click;
   - **an approve sends the rendered `hash`;**
   - **when the banner is offline,** no action button is enabled;
   - **on a `conflict` `ApiError`,** the view re-renders and shows the conflict sentence, and doesn't call `api` again by itself.
3. **`untrusted.test.ts`:**
   - **Every string field** of every fixture is replaced, one field at a time, with `<img src=x onerror=alert(1)>"'&` and with `javascript:alert(1)`. Mounting each view must then:
     - create no element from it;
     - put it nowhere but a text node;
     - produce no `href` other than `prUrl`'s `https://github.com/…/pull/<n>`.
   - **A static scan** of `packages/ui/web/**/*.ts` finds none of these: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`, `setAttribute('on`, inline `style=`, or `localStorage`.
4. **`a11y.test.ts`.** For every mounted view:
   - every `button`, `input`, `select` and `textarea` has an accessible name (text, `aria-label`, or a `<label for>`);
   - there are no clickable `div`s;
   - the banner is `role=status` and `aria-live=polite`;
   - each state with a color class also has words.
5. **Then fix what the tests find, inside `packages/ui/web/` only.** Keep each fix small, and don't change an exported name that another view uses. If a fix needs `api.ts`'s behavior to change, or anything outside SCOPE, report it with `task_blocked` instead.

TESTS. Run only:
- `node --test packages/ui/test/`
- `node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json`

DONE WHEN: every UI test passes, including the other cards' tests, run through the same command. The static scan is clean. No file outside SCOPE is changed. Then call `report_done` with what you fixed, one line each.
