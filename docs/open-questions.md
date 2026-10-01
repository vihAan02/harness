# Open questions

> **Scope:** only questions that genuinely matter, each with the phase it blocks. [PLAN.md](../PLAN.md) wins on any conflict.
>
> **When a question is answered,** record the answer as a new D-ID in PLAN.md and mark the question **Resolved → D-xx**. Don't delete it.

| ID | Question | Blocks | Status |
|---|---|---|---|
| [Q-01](#q-01) | Implementation stack | Any 0A code | **Open, needs owner** |
| [Q-02](#q-02) | A/B repo and scenario details | Repo chosen during 0A; scenarios built in 0B | Open |
| [Q-03](#q-03) | Approve the A/B pass bar | Running the A/B test | **Open, needs owner** |
| [Q-04](#q-04) | Vendor login: subscription vs API key | 0A item 0 (the spike runs real agents); any commercial launch | **Open, needs owner** |
| [Q-05](#q-05) | Message budget defaults | Nothing (the proposal is the 0A default unless the owner objects) | Proposal |
| [Q-06](#q-06) | How good read-set coverage has to be, and shell-read handling | 0B | Open |
| [Q-07](#q-07) | Policy when two hard claims race | 0B | Open (proposal below) |
| [Q-08](#q-08) | Where tests run before landing or opening a PR | 1 | 0B answered by D-51; Phase 1 open |
| [Q-09](#q-09) | Where the coordination server is hosted in Phase 1 | 1 | Open |
| [Q-10](#q-10) | Identity, sign-in and signing keys | 1 | Open |
| [Q-11](#q-11) | GitHub plan limits and GitHub-only | 1 | Open |
| [Q-12](#q-12) | The original proposal text is missing | Nothing (context only) | Open |
| [Q-13](#q-13) | How contract changes get detected beyond file paths | 1 / 2 | Open |
| [Q-14](#q-14) | Where humans review and approve | 1 | Open |
| [Q-15](#q-15) | Retention and privacy for messages and read sets | 1 | Open |
| [Q-16](#q-16) | Product name | Nothing | Open |

---

### Q-01
**Implementation stack.**
- **Why it matters:** it decides the repo skeleton, which SDKs we can use natively, and how `harnessd` ships.
- **Recommendation:** TypeScript on Node for the server, daemon, adapters and CLI, with Postgres. The research supports this:
  - The Claude Agent SDK is **TypeScript-first**. Python gets only 10 hook callbacks and fewer control methods (F-01).
  - Raw `claude -p` stream-json works, but its control protocol has no standalone spec (F-23).
  - Codex's app-server can generate TypeScript types (`codex app-server generate-ts`, F-34), and its TS SDK exists, though it only takes input between turns (F-33).
  - One language for protocol types end to end.
- **Alternative:** Go or Rust for `harnessd`, for a single static binary and lower memory.
  - Each Claude agent would need a small TS sidecar to keep in-process hooks (PreToolUse callbacks fail closed, F-05) and streaming input.
  - Or drive the partly documented CLI protocol directly.
  - Recommended against for Phase 0.
- **Blocks:** any 0A code ([PLAN.md §12](../PLAN.md#12-what-must-happen-before-and-during-phase-0a)).

### Q-02
**A/B repo and scenarios.**
- **What's needed:** a real, small-to-medium repo with a working test suite, a backend API, a frontend consumer, a DB schema and a shared types file, so that SC-1 to SC-4 in [validation.md](validation.md#scenarios-real-coupling-planted-on-purpose) can be planted naturally.
- **Options:**
  - one of the owner's own projects (best realism, if the coupling exists);
  - a purpose-built fixture repo (best control).
- **Timing:** choose the repo during 0A. Build the scenarios, baseline recorder, playbook and rubric in 0B (roadmap 0B item 9).

### Q-03
**Approve the A/B pass bar:** approve or edit [validation.md §5](validation.md#5-pass-bar-proposal-pending-owner-approval-q-03) **as written**. P1–P3 and G1–G4 are defined there, and this page deliberately doesn't paraphrase them.
- **Needs the owner's approval** before the first A/B run.
- **Recommendation:** fix the bar before the first run. Changing it after seeing results weakens the test. It's the owner's call, and any change gets recorded with its reason.

### Q-04
**Vendor login: subscription vs API key.**
- **The question:** can a product's daemon drive Claude Code and Codex on a user's machine under that user's consumer subscription, or must it require API keys?
- **Why it matters:** cost model, onboarding, and the terms risk TH-11.
- **What the research found (2026-10-01; not legal advice).** Details are in [vendor-capabilities.md](research/vendor-capabilities.md#vendor-terms-not-legal-advice), F-60 to F-71.
  - **Anthropic: the sources conflict.**
    - The Agent SDK docs say third-party products may not offer claude.ai login unless previously approved, and `claude -p` counts as the SDK.
    - The legal page *allows* products to run the **unmodified** Claude Code binary with each end user signing in with their **own** credentials, including a subscription. It forbids touching or intermediating tokens.
    - Pro and Max limits assume "ordinary, individual usage".
    - Policy moves in 2026 per secondary reports: spoofing blocks in January, third-party harness traffic moved to "extra usage" in April (F-65). There were also billing changes (F-64).
    - **Risk in subscription mode: medium-high. Risk with an API key or cloud provider: low.**
  - **OpenAI:**
    - `codex exec` with the user's saved ChatGPT login is documented, but API keys are recommended for automation (F-68).
    - App-server ChatGPT auth is "never permitted for commercial or hosted services" (F-70).
    - Commercial use of a user's plan goes through "Sign in with ChatGPT", currently a limited trial (F-70).
    - A product launching the user's own logged-in `codex exec` is **not documented either way** (F-71 ◐). Secondary reports suggest OpenAI is permissive.
    - **Risk in ChatGPT-login mode: low-medium (lower confidence, since it's undocumented). Risk with an API key: low.**
- **Fixed regardless of the answer (D-48):**
  - never read, store, proxy or intermediate credentials or model traffic;
  - unmodified vendor binaries;
  - the user picks the auth mode;
  - never restrict built-in auth methods.
- **Decisions needed:**
  1. **The owner's own 0A/0B experiments.** **Recommendation:** API keys.
     - It's the cleanest reading of Anthropic's Agent SDK note.
     - Usage can be reconciled against the API console's billing (SDK cost figures are client-side estimates, F-16). That matters for M8.
     - It avoids the classifier issues.
     - Both A/B arms use the same auth.
  2. **The product's default before any commercial launch.** **Recommendation:** API-key mode by default, and subscription mode only as an option the user explicitly picks. Get **written confirmation** from both vendors first.
- **Questions to put to the vendors in writing:**
  1. **Anthropic, prior approval:** does a local daemon that only launches the user's own logged-in, unmodified `claude` / Agent SDK need "prior approval" under the Agent SDK note? Is that "offering claude.ai login"?
  2. **Anthropic, usage:** does running N agents in parallel count as "ordinary, individual usage"? Will that traffic draw from plan limits or usage credits?
  3. **Anthropic, which terms:** does the Commercial Terms "run Claude Code in your products" section govern a locally installed daemon, and does it cover Free/Pro/Max end users?
  4. **OpenAI:** may commercial orchestrators launch `codex exec` under the user's own ChatGPT login, or must they use API keys or join "Sign in with ChatGPT"?
  5. **Both vendors:** what attribution or identification is required, and how much notice will they give before policy changes?

### Q-05
**Message budget defaults (D-24).** This is a **PROPOSAL** and the 0A default unless the owner objects.
- **Per task:** 10 peer messages sent and 10 received.
- **Text cap:** 500 characters on `text` (a config value).
- **Harness notices** aren't counted against the budget, but are deduplicated.
- **Over budget,** messages are held and shown to the human.
- **Tokens:** coordination tokens are **measured** (estimated as injected characters ÷ 4) but **not budgeted** in 0A. Whether to add a token budget is decided from 0B and A/B data.
- **The A/B test reports actual usage,** so the numbers can be tuned.

### Q-06
**How good read-set coverage has to be, and how shell reads are handled (D-23).**
- **The questions:**
  - What coverage is good enough to rely on?
  - How hard should we try to parse shell reads (`cat`, `sed`, `rg`, scripts)?
  - Should a vendor without read hooks still get stale-context notices, from edits plus diffs only?
- **Proposal:** 0B measures coverage (H-03). A notice is never suppressed because coverage is low; its confidence is labeled instead.

### Q-07
**What happens when two hard claims race.**
- **Proposal:** first come, first served, and the loser gets `claim_conflict`.
- **Open:** do humans get a manual override? Do claims have priorities? How does this interact with deadlock resolution (D-27)?
- **Blocks:** 0B.

### Q-08
**Where tests run before landing or opening a PR.**
- **The question:** in the agent's worktree (fast, but needs bootstrap and resources) or only in CI (neutral, but slow)?
- **0B: answered by D-51.** The land step runs the approved `test.command` on the merged result in an integration worktree, before the base moves. Agents may also run tests in their own worktree as an early signal.
- **Phase 1 (open):** GitHub CI is the authority (D-31). Should local runs be required before `harness land` opens the PR?

### Q-09
**Where the coordination server is hosted in Phase 1.** A managed Postgres plus a small WebSocket service, or self-hosted.
- **Things to weigh:** latency for both people, cost (S1: the real infra cost is always-on WebSocket and Postgres, not storage), and data residency.

### Q-10
**Identity, sign-in and signing keys.**
- **The open parts:**
  - how humans sign in (GitHub OAuth is natural, since GitHub is the code host);
  - how devices are enrolled;
  - where the server's command-signing key lives and how it rotates;
  - how agent principals are minted, and how each session is bound to one.
- **Blocks:** Phase 1 security (D-33, D-34).

### Q-11
**GitHub plan limits and GitHub-only.**
- **Merge queue availability** (F-50, F-51, F-53): org-owned public repos, private org repos on Enterprise Cloud, or GHES only.
  - **Does the owner's GitHub setup qualify?**
  - **If not,** D-51's fallback uses GitHub's own features: required checks (incl. `harness/claims`), "require branches to be up to date before merging", and auto-merge. The harness **does not** run its own merge train.
  - **To verify:** whether those branch-protection features are available on the owner's plan for private repos, and how GitHub's "update branch" and auto-merge behave when `harnessd` syncs and pushes open task branches (D-51).
- **Other hosts:** is GitLab or another host in scope later? The current answer is GitHub only.

### Q-12
**The original proposal text is missing.** S1 reviewed a proposal that isn't on disk. Its parts are reconstructed from S1's references in [PLAN.md §1](../PLAN.md#1-context-and-provenance).
- **If the owner finds it,** add it to `docs/source/` as a raw record.
- **Blocks:** nothing.

### Q-13
**How contract changes get detected beyond file paths (D-30).**
- **Phase 1:** declared contract files.
- **Later:** parsed diffs (OpenAPI, Prisma/SQL migrations, TypeScript type exports) and consumer mapping through import graphs or a language server. Which languages first?
- **Blocks:** Phase 1 scope, Phase 2 design.

### Q-14
**Where humans review and approve.**
- **0B:** the human triggers land (D-54).
- **Phase 1:** a PR review on GitHub, plus local approval prompts for security events and `harness.yaml` changes (D-52).
- **Open:** should there be a harness-level gate before an agent's branch becomes a PR, for example a human approving the diff summary?

### Q-15
**Retention and privacy for messages and read sets.**
- **What's stored:** read sets hold paths and hashes only (TH-12), and message text is capped.
- **Open:** how long text and events are kept, who on the team can see which agent's read set, and whether private notes are possible.

### Q-16
**Product name.** "Harness" is a working name.
