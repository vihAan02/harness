# S6: Owner's go-ahead for 0A item 4, with four picks (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S6 conflict, S6 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. The picks are recorded there as D-75.
>
> **Provenance:** written by the owner on 2026-10-02 in a Claude Code session, answering the proposal below. Verbatim.

**The proposal it answers** (Claude's recommendations for four open points in item 4):

````text
1. Config file parsers. The docs specify config.toml and harness.yaml, which means adding two small parsing libraries. I'd add them rather than change the formats.
2. Approving the setup command before the CLI exists (item 9). I'd add a minimal `harness approve` command now, rather than a prompt inside the daemon.
3. Heartbeat events. protocol.md logs every device.heartbeat as an event, which would add one event per device every few seconds. I'd record the time on the device row and only log presence changes (online/offline). That changes the protocol doc, so it's your call.
4. How the daemon runs in 0A. I'd run it in the foreground (`npm run daemon`), with no background login service yet.
````

**The owner's answer:**

````text
go with your picks on all 4, start step 4
````
