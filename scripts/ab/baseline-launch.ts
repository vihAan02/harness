// The A/B baseline arm's launcher (validation.md §3; A7, D-102). Starts an interactive Claude Code in one
// worktree with the harness arm's policy, from the same local config harnessd uses: the provider and model,
// read confinement, sandbox and settings, env, the port block, and the repo's instruction files appended the
// same way. None of the treatment: no harness tools, standing instructions, notices, claims or sync.
//
//   node scripts/ab/baseline-launch.ts --worktree <dir> --repo <main checkout> --agent <name> [--ports <base>:<count>]
//          [--prompt-file <file>] [--session-id <uuid>] [--print]
//
// One launcher per agent, each in its own terminal; the A/B runner (B9b) prepares the worktrees and prints or
// opens these commands. --prompt-file is the agent's first message (its task card), sent as the CLI's
// initial prompt; --session-id names the session, so the runner can find its transcript and stop it at the
// end. --print shows the command and the environment's names instead of starting it.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ClaudeAdapter, type SessionSpec } from '../../packages/adapters/src/index.ts';
import {
  environmentInstructions, harnessHome, loadConfig, portEnv, readPolicyFor, readRepoInstructions, resolveProvider, type Home,
} from '../../packages/daemon/src/index.ts';
import { gitCommonDir } from '../../packages/daemon/src/git.ts';

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type BaselineInput = {
  worktree: string; repo: string; agent: string; ports: { base: number; count: number } | null;
  home?: Home; env?: NodeJS.ProcessEnv; log?: (m: string) => void;
};

/** The session the baseline agent gets: what harnessd would give it, without the harness's tools or text. */
export async function baselineSpec(o: BaselineInput): Promise<SessionSpec> {
  if (!AGENT_NAME.test(o.agent)) throw new Error('--agent must be a short name like frontend');
  const home = o.home ?? harnessHome();
  const env = o.env ?? process.env;
  const config = loadConfig(home);
  const provider = resolveProvider(config, env);
  const worktree = fs.realpathSync(o.worktree);
  const repo = fs.realpathSync(o.repo);
  const commonDir = await gitCommonDir(repo);
  // Its own vendor config dir, as each harness agent has one (D-65), inside harness state like theirs.
  const configDir = path.join(home.root, 'baseline', o.agent, 'claude-config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  return {
    sessionId: randomUUID(), worktree, gitCommonDir: commonDir, configDir,
    ports: o.ports, env: o.ports ? portEnv(o.ports) : {}, secrets: {}, auth: provider.auth, tools: [],
    instructions: environmentInstructions({ ports: o.ports, repo: readRepoInstructions(worktree) }).join('\n\n'),
    ...(provider.model ? { model: provider.model } : {}),
    readPolicy: readPolicyFor({
      home: os.homedir(), harnessRoot: home.root, repo, worktree, gitCommonDir: commonDir,
      readAllow: config.agents.readAllow, pathEnv: env.PATH ?? '', tmpdir: os.tmpdir(), env,
    }, (m) => o.log?.(`baseline ${o.agent}: ${m}`)),
    log: (m) => o.log?.(m),
  };
}

function parsePorts(v: string | undefined): { base: number; count: number } | null {
  if (!v) return null;
  const m = /^(\d{4,5}):(\d{1,3})$/.exec(v);
  if (!m) throw new Error('--ports is <base>:<count>, e.g. 31000:10');
  return { base: Number(m[1]), count: Number(m[2]) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      worktree: { type: 'string' }, repo: { type: 'string' }, agent: { type: 'string' }, ports: { type: 'string' },
      'prompt-file': { type: 'string' }, 'session-id': { type: 'string' }, print: { type: 'boolean' },
    },
  });
  if (!values.worktree || !values.repo || !values.agent) throw new Error('usage: baseline-launch --worktree <dir> --repo <main checkout> --agent <name> [--ports <base>:<count>] [--prompt-file <file>] [--session-id <uuid>] [--print]');
  const sessionId = values['session-id'];
  if (sessionId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) throw new Error('--session-id must be a UUID');
  const spec = await baselineSpec({ worktree: values.worktree, repo: values.repo, agent: values.agent, ports: parsePorts(values.ports), log: (m) => process.stderr.write(`${m}\n`) });
  const launch = new ClaudeAdapter().interactiveLaunch(sessionId ? { ...spec, sessionId } : spec);
  // The first message goes last, as the CLI's initial prompt; it's text, never parsed as a flag.
  const prompt = values['prompt-file'] ? fs.readFileSync(values['prompt-file'], 'utf8').trim() : '';
  if (prompt.startsWith('-')) throw new Error('the prompt must not start with "-"');
  if (prompt) launch.args.push(prompt);
  if (values.print) {
    // The key is in the environment, never in the arguments (D-64); only the names are shown.
    process.stdout.write(`${JSON.stringify({ cwd: launch.cwd, command: launch.command, args: launch.args, env: Object.keys(launch.env).sort() }, null, 2)}\n`);
    return;
  }
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (import.meta.main) main().catch((e: Error) => { process.stderr.write(`baseline-launch: ${e.message}\n`); process.exit(1); });
