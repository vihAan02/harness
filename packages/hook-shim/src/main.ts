#!/usr/bin/env node
/**
 * mp-hook <vendor>: the command hook Codex runs for every lifecycle event.
 *
 * Reads the hook payload from stdin, forwards it to mp-daemon at /v1/hooks/<vendor>/<event>, and
 * prints the daemon's JSON answer. The daemon's port and token come from $MP_HOME/daemon.json (never
 * from the hook definition, so the definition stays byte-identical and Codex only asks to trust it
 * once). The agent id comes from $MP_AGENT_ID, which mp-daemon sets on the Codex app-server.
 *
 * Fails open: on any problem it prints `{}` and exits 0, so Codex carries on as if no hook ran.
 * Deliberately dependency-free and small, because it starts once per tool call.
 */
import { EMPTY, forward, readStdin } from "./forward.ts";

readStdin()
  .then((raw) => forward(process.argv[2] || "codex", raw))
  .catch(() => EMPTY)
  .then((out) => {
    process.stdout.write(out);
    process.exit(0);
  });
