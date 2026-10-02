// The internal coordination protocol (D-14): what harnessd, the CLI and the server speak.
// docs/protocol.md is canonical for event, command, tool and message-kind names.

/** Carried as `v` on every message (protocol.md §1, §10). */
export const PROTOCOL_VERSION = 1;
