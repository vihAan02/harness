// harnessd, the per-device daemon (docs/local-runtime.md): the execution and security boundary
// (D-32). It supervises agents only through @harness/adapters and owns every Git write (D-50).
export { Daemon, type DaemonOptions, type TaskWorkspace } from './daemon.ts';
export { harnessHome, type Home } from './home.ts';
export { loadConfig, parseConfig, type LocalConfig } from './config.ts';
export { Approvals, setupHash, type ApprovalRequest } from './approvals.ts';
export { ServerLink, CommandFailed } from './link.ts';
export { Sessions, killOrphans, processStart, type SessionRecord } from './supervision.ts';
