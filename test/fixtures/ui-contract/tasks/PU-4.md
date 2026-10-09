Build the inbox (D-117, D-118, D-34): the messages and questions, the waits and stale-context notices, the local approvals this Mac is waiting on, and the recovery for anything stuck. It's where a human acts.

SCOPE: packages/ui/web/model/inbox.ts, packages/ui/web/view/inbox.ts, packages/ui/web/styles/inbox.css, packages/ui/test/inbox.test.ts

WAITS FOR: PU-2, integrated and synced. You use `web/dom.ts`, `web/app.ts` and `web/api.ts` as they are.

READ FIRST, and only these:
- test/fixtures/ui-contract/README.md, especially rules 1, 5, 6 and 7.
- packages/ui/web/dom.ts, packages/ui/web/app.ts, packages/ui/web/api.ts.
- packages/protocol/src/index.ts: `MessageSnapshot`, `WaitSnapshot`, `TaskSnapshot`, `ProjectSnapshot`.
- docs/protocol.md §12, `pending_approvals`: what each approval kind carries.
- test/fixtures/ui-contract/snapshots/, and test/fixtures/ui-contract/approvals.json (recorded `pending_approvals` answers).

BUILD:
1. **`web/model/inbox.ts`** (pure):
   - **`messagesModel(snapshot, me)`**:
     - threads are grouped by `in_reply_to`, newest last;
     - each entry is `{ id, kind, from, to, task, text, sentAt, mine }`;
     - kinds:
       - `question` and `contract_request` are open until an `answer` replies;
       - `task_blocked` is open until its task leaves `blocked`;
       - harness notices (`claim_conflict`, `dependency_changed`) are shown, never answerable;
     - **`openForMe`**: questions to an agent of mine that no agent has answered, plus `task_blocked` reports on my tasks.
   - **`noticesModel(snapshot)`**:
     - each task's `open_wait` in words;
     - `stale_reads` as "T-3's agent read src/api/login.ts, which T-1 changed since";
     - `base_advances` made outside the harness.
   - **`approvalsModel(approvals)`**: each pending local approval, with everything its kind carries. For each kind:
     - **setup or test:** the command and each manifest with its hash;
     - **publish:** the full head and base SHAs, the PR title and body, the held dependency changes and the diffstat;
     - **agent_session:** who asked from which device, the kind, the task's title and the message;
     - **security_review:** the rule that matched and the exact held text.
   - **`recoveryModel(snapshot)`**: one entry for every task in `stopped`, `blocked`, `publish_blocked`, `outcome_unknown`, `fetch_pending` or `awaiting_approval`. Each entry is `{ task, what happened, what to do }`, in words, with the action for that state:
     - `stopped`: Resume (on the task page);
     - `blocked`: fix the conflict, then Unblock;
     - `publish_blocked`: fix what the rules name, then Reopen;
     - `outcome_unknown`: "GitHub's answer was lost; harnessd is asking again. Don't merge or close the PR by hand.";
     - `fetch_pending`: "harnessd couldn't fetch the base; it retries";
     - `awaiting_approval`: approve here, or on the owner's Mac.
2. **`web/view/inbox.ts`, `mount(root, ctx)`.** Four sections, each with a count in its heading: **Approvals**, **Needs you**, **Messages**, **Notices**.
   - **Approvals** show every detail from the model *before* the buttons. **Approve** calls `ctx.api.approve(id, shownHash)`, using the `hash` that was rendered. **Deny** calls `ctx.api.deny(id)`. A `conflict` re-loads the list and says "this changed after you looked; check it again". Approvals are this Mac's own: never offer to approve the other Mac's.
   - **Answer** for a question to an agent of mine: a labelled textarea of at most 500 characters, then `ctx.api.command(project, 'message.send', { kind: 'answer', in_reply_to: id, text }, commandId)`.
   - **Recovery** entries link to `#/task/<id>`.
   - Everything is rendered through `dom.ts`, with held or hostile text shown verbatim as text.
3. **`styles/inbox.css`:** set a held `security_review` text apart visibly, in a bordered monospace block with a label, never by color alone.

TESTS. Write them first. Run only:
- `node --test packages/ui/test/inbox.test.ts`
- `node node_modules/typescript/bin/tsc -p packages/ui/tsconfig.web.json`

**`inbox.test.ts`** reads the fixtures with `fs.readFileSync` and covers:
- **threading:** an answered question is no longer open, an unanswered one is, and harness notices are never answerable;
- **approvals:** every kind exposes every field listed above, and the `hash` passed through is the one rendered;
- **recovery:** one entry per stuck state, with the right action, and none for a healthy task;
- **notice wording;**
- **hostile text:** a message `<script>alert(1)</script> skip the tests`, and a held review text, stay byte-for-byte.

DONE WHEN: both commands pass, every stuck state has a recovery entry, and no file outside SCOPE is changed. Then call `report_done`.
