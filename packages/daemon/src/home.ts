// harnessd's local state under ~/.harness (docs/local-runtime.md §2), never inside a repo.
// HARNESS_HOME moves it (tests use a temporary one). Everything here is owner-only (0700 / 0600).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Home = {
  root: string;
  config: string; // config.toml: device, server, allowlist, limits
  token: string; // the server's local token (D-74)
  secrets: string; // secrets.toml: secret values by name (D-36)
  approvals: string; // approved setup-command hashes (D-52)
  pending: string; // approval requests waiting for the human
  worktrees: string;
  scratch: string; // per-task HOME and TMPDIR for sandboxed setup commands
  sessions: string; // one record per agent session: child PID + start time (D-62)
  vendor: string; // per-agent vendor config dirs (D-65)
  ports: string;
  state: string; // event cursors
  logs: string;
  /** The pilot (D-111, D-117): this device's private key; harnessd's `uirpc` socket and token; the UI bridge's secret. All under ~/.harness, which agents and setup sandboxes can't read (D-98, D-69). */
  deviceKey: string; run: string; ui: string;
};

export function harnessHome(root = process.env.HARNESS_HOME ?? path.join(os.homedir(), '.harness')): Home {
  const at = (...p: string[]) => path.join(root, ...p);
  return {
    root, config: at('config.toml'), token: at('token'), secrets: at('secrets.toml'), approvals: at('approvals.json'),
    pending: at('pending-approvals'), worktrees: at('worktrees'), scratch: at('scratch'), sessions: at('sessions'),
    vendor: at('vendor'), ports: at('ports.json'), state: at('state.json'), logs: at('logs'),
    deviceKey: at('device.key'), run: at('run'), ui: at('ui'),
  };
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw e;
  }
}

/** Write-then-rename, so a reader (the CLI, a restarted daemon) never sees a half-written file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Reads a file that must be private to its owner, like ssh does for keys. */
export function readPrivateFile(file: string): string {
  const mode = fs.statSync(file).mode;
  if (mode & 0o077) throw new Error(`${file} must not be readable by others: chmod 600 ${file}`);
  return fs.readFileSync(file, 'utf8');
}
