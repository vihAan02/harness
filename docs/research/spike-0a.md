# Phase 0A adapter spike: results

> **Status:** in progress (D-59). Results are filled in as experiments run.
>
> **Result labels (S4):** VERIFIED · CONTRADICTED · PARTIAL · UNVERIFIED, each with the exact vendor and runtime versions tested.

| # | Question (S4) | Result |
|---|---|---|
| 1 | Can `harnessd` launch and supervise two independent Claude sessions programmatically? | pending |
| 2 | Can we inject a message into a running session at a predictable safe point? | pending |
| 3 | Can we capture edits reliably? | pending |
| 4 | What read operations can we actually observe? | pending |
| 5 | Can we prevent the agent from writing outside its assigned worktree? | pending |
| 6 | Can we prevent repo-provided hooks/MCP/config from gaining unintended execution? | pending |
| 7 | Can we resume a session after stopping the process? | pending |
| 8 | Can two sessions run concurrently without interfering with each other's config, ports, Git state or credentials? | pending |
| 9 | What information can the adapter reliably expose about session state? | pending |
| 10 | What fails open versus fails closed? | pending |
