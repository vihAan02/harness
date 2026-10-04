// Runs an approved setup command under Anthropic's sandbox runtime, srt (D-52, D-69). The sandbox
// config is generated per run:
// - writes only to the worktree and this task's scratch dir (its HOME and TMPDIR, where package
//   managers put caches);
// - the shared .git is write-denied;
// - harnessd's own state (token, secrets, other worktrees, agent config dirs) and the usual
//   credential locations are read-denied, with only this task's worktree and scratch dir allowed back;
// - network limited to the local allowlist, never the repo's;
// - an explicit env with no secrets.
// srt refuses to run on an invalid config, so a broken config fails closed (SP-12).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, type Home } from './home.ts';

const SRT_CLI = path.join(path.dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json')), 'dist', 'cli.js');

/** Credential locations in the real home directory that no setup command or agent may read (D-52, D-98). */
export const CREDENTIAL_PATHS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.docker', '.kube', '.netrc', '.npmrc', '.pypirc',
  '.claude', '.claude.json', '.codex', 'Library/Keychains',
  '.git-credentials', '.config/git/credentials', '.config/hub', '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials',
  '.local/share/keyrings', '.local/share/uv/credentials', '.azure', '.terraform.d/credentials.tfrc.json', '.vault-token',
  '.password-store', '.config/op', '.bunfig.toml', '.yarnrc.yml'];

export type SetupRun = {
  home: Home; worktree: string; gitCommonDir: string; scratch: string; command: string;
  allowedDomains: string[]; timeoutMs: number; logFile: string;
  /**
   * Lets the command bind and reach local ports: a land's test command starts servers on 127.0.0.1 (D-83).
   * srt then allows binding on every interface and inbound connections, outbound only to localhost (F-58).
   */
  allowLocalBinding?: boolean;
};

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The sandbox matches real paths, so resolve symlinks such as macOS's /var → /private/var, and each component's on-disk case. */
const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return p; } };

export function sandboxSettings(r: SetupRun) {
  const realHome = real(os.homedir());
  const [worktree, scratch] = [real(r.worktree), real(r.scratch)];
  return {
    filesystem: {
      allowWrite: [worktree, scratch],
      denyWrite: [real(r.gitCommonDir)],
      // Each credential path where it is and where it really is (a dotfiles repo may symlink ~/.ssh).
      denyRead: [...new Set([real(r.home.root), ...CREDENTIAL_PATHS.flatMap((p) => [path.join(realHome, p), real(path.join(realHome, p))])])],
      allowRead: [worktree, scratch],
    },
    network: { allowedDomains: r.allowedDomains, deniedDomains: [], ...(r.allowLocalBinding ? { allowLocalBinding: true } : {}) },
  };
}

export async function runSetup(r: SetupRun): Promise<{ exitCode: number; timedOut: boolean }> {
  for (const d of [path.join(r.scratch, 'home'), path.join(r.scratch, 'tmp'), path.dirname(r.logFile)]) ensureDir(d);
  const settings = path.join(r.scratch, 'srt-settings.json');
  fs.writeFileSync(settings, JSON.stringify(sandboxSettings(r), null, 2), { mode: 0o600 });
  const env = {
    PATH: [path.dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: path.join(r.scratch, 'home'),
    // srt puts its own Unix sockets in TMPDIR, and macOS caps socket paths at 104 bytes, so srt gets a
    // short one. The command's TMPDIR is set inside the sandboxed shell instead.
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
  };
  const command = `export TMPDIR=${shellQuote(path.join(r.scratch, 'tmp'))}; ${r.command}`;
  // Output goes through pipes that harnessd copies to the log. The log lives under ~/.harness, which
  // the sandbox read-denies, and macOS also checks writes to an inherited file descriptor's path.
  const log = fs.createWriteStream(r.logFile, { flags: 'a', mode: 0o600 });
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SRT_CLI, '-s', settings, '-c', command], { cwd: r.worktree, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
        setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 5000).unref();
      }, r.timeoutMs);
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: code ?? (signal ? 128 : 1), timedOut }); });
    });
  } finally {
    await new Promise<void>((resolve) => log.end(resolve));
  }
}
