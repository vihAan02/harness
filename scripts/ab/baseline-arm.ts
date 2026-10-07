// The A/B baseline arm (validation.md §3, §9; B9b, D-102, D-121): two interactive Claude Code sessions, one
// per task, each in its own worktree and terminal, launched with the harness arm's policy and none of the
// treatment (A7's launcher). The coordinator relays between the terminals by hand and integrates with the
// console's `merge`, which does what the land step does without its fencing check: merge into main in an
// integration worktree, run the setup and test commands there under the same sandbox, and move main only if
// green (`--no-tests` skips the tests, as `harness land --no-tests` does: D-124). `sync` merges main into an
// agent's branch, as harnessd's sync does. Setup before the clock starts
// (worktrees, the setup command, ports) isn't counted, as harnessd's isn't.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaudeAdapter } from '../../packages/adapters/src/index.ts';
import { DUMMY_KEY } from '../../packages/adapters/test/mock-api.ts';
import type { Home, LocalConfig, ResolvedProvider } from '../../packages/daemon/src/index.ts';
import { branchTip, commitAll, gitCommonDir } from '../../packages/daemon/src/git.ts';
import { addIntegrationWorktree, advanceBase, mergeCommit, removeIntegrationWorktree } from '../../packages/daemon/src/integrate.ts';
import { readRepoConfig } from '../../packages/daemon/src/repo-config.ts';
import { PortAllocator } from '../../packages/daemon/src/resources.ts';
import { runSetup } from '../../packages/daemon/src/setup.ts';
import { syncWorktree } from '../../packages/daemon/src/sync.ts';
import { baselineSpec } from './baseline-launch.ts';
import type { CoordinatorConsole } from './console.ts';
import type { Recorder } from './recorder.ts';
import type { RunSummary } from './summary.ts';
import { commitsAfterFirst, untestedRetry, type IntegrationAttempt } from './summarize.ts';
import { readTranscript, transcriptFiles, transcriptUsage } from './transcripts.ts';

type CardTask = { key: string; agent: string; title: string; scope: string[]; phrasings: string[] };
export type BaselineInput = {
  scenario: string; tasks: CardTask[]; phrasing: number; capMs: number; rec: Recorder; root: string; repo: string;
  home: Home; config: LocalConfig; provider: ResolvedProvider | null; mockUrl: string | null;
  /** headless: the runner starts both CLIs in pseudo-terminals itself; terminal: two Terminal.app windows; print: the commands, for the coordinator. */
  launch: 'headless' | 'terminal' | 'print';
  /** The runner integrates each task once its agent's turn ends (dry runs and rehearsals). */
  autoIntegrate: boolean;
  /** Each task's first prompt: its card's phrasing, or a dry run's scripted program. */
  prompt: (t: CardTask, worktree: string) => string;
  stopRequested: () => boolean;
  console: CoordinatorConsole | null;
  /** This checkout, where `scripts/ab/baseline-launch.ts` is (for the commands a terminal runs). */
  harnessRoot: string;
};
type Agent = {
  task: CardTask; worktree: string; branch: string; sessionId: string; configDir: string; ports: { base: number; count: number };
  child: ChildProcess | null; integratedAt: number | null; attempts: number; testedOnce: boolean;
  /** How its latest `merge` ended (the integration mark's outcome). */
  lastOutcome: string | null;
  /** A message the runner typed and the agent hasn't taken yet: when, and how many prompts its transcript had then. */
  relay: { at: number; prompts: number } | null;
};

const COORDINATOR = { name: 'Coordinator', email: 'coordinator@harness.invalid' };
const sq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Runs a command in a pseudo-terminal, copying its screen to a log and our stdin to it (text the runner types). */
const PTY = `
import os, pty, sys, select, fcntl, termios, struct
log = open(sys.argv[1], 'ab')
pid, fd = pty.fork()
if pid == 0: os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
src = 0
while True:
    r, _, _ = select.select([fd] + ([src] if src is not None else []), [], [], 0.5)
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        log.write(data); log.flush()
    if src is not None and src in r:
        data = os.read(src, 65536)
        if data: os.write(fd, data)
        else: src = None
    if os.waitpid(pid, os.WNOHANG)[0]: break
`;

/** Kills whatever runs with this session id (the CLI started from a terminal is no child of ours). */
function killSession(sessionId: string): void {
  let pids: number[] = [];
  try { pids = execFileSync('pgrep', ['-f', `session-id=${sessionId}`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch {}
  for (const pid of pids) if (pid !== process.pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
}

/** The session's transcript, as lines (none yet: empty). */
function sessionLines(configDir: string, sessionId: string): string[] {
  const file = transcriptFiles(configDir).find((f) => path.basename(f) === `${sessionId}.jsonl`);
  return file ? fs.readFileSync(file, 'utf8').split('\n') : [];
}

/** True once the session's transcript shows a finished turn and nothing new for `quietMs`. */
function turnEnded(configDir: string, sessionId: string, quietMs: number): boolean {
  const file = transcriptFiles(configDir).find((f) => path.basename(f) === `${sessionId}.jsonl`);
  if (!file || Date.now() - fs.statSync(file).mtimeMs < quietMs) return false;
  const last = fs.readFileSync(file, 'utf8').trim().split('\n').reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((e) => e && !e.isSidechain && !e.isMeta && (e.type === 'assistant' || e.type === 'user'));
  if (!last || last.type !== 'assistant') return false;
  const content = Array.isArray(last.message?.content) ? last.message.content as { type?: string }[] : [];
  return !content.some((b) => b.type === 'tool_use');
}

export async function runBaseline(b: BaselineInput): Promise<{
  outcome: RunSummary['outcome']; summary: Omit<RunSummary, 'run_id' | 'phrasing' | 'cap_ms' | 'started_at' | 'ended_at' | 'void'>;
  agents: { name: string; configDir: string }[]; commits: { key: string; commit: string | null }[]; attempts: IntegrationAttempt[];
}> {
  const { rec, repo, home, config } = b;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const baseSha = git(repo, 'rev-parse', 'main');
  const commonDir = await gitCommonDir(repo);
  const rc = readRepoConfig(repo);
  const ports = new PortAllocator(home, config.limits.portRange, rc.portsPerAgent ?? config.limits.portsPerAgent, 2);
  const agents: Agent[] = [];
  const setupCmd = async (worktree: string, command: string, name: string, tests: boolean) => runSetup({
    home, worktree, gitCommonDir: commonDir, scratch: path.join(home.scratch, 'baseline', name), command,
    allowedDomains: tests ? [] : config.setup.allowedDomains, ...(tests ? { allowLocalBinding: true } : {}),
    timeoutMs: (tests ? Math.min(rc.test?.timeoutSeconds ?? config.setup.timeoutSeconds, config.setup.timeoutSeconds) : config.setup.timeoutSeconds) * 1000,
    logFile: path.join(home.logs, `baseline-${name}.log`),
  });

  // Before the clock: each agent's worktree and branch, its setup command, and its port block.
  for (const t of b.tasks) {
    const worktree = path.join(b.root, 'worktrees', t.agent);
    const branch = `ab/${t.key}-${t.agent}`;
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(repo, 'worktree', 'add', '-q', '-b', branch, worktree, baseSha);
    if (rc.setup) {
      const r = await setupCmd(worktree, rc.setup.command, `setup-${t.agent}`, false);
      if (r.exitCode !== 0) throw new Error(`the setup command failed in ${t.agent}'s worktree (exit ${r.exitCode}); see ${path.join(home.logs, `baseline-setup-${t.agent}.log`)}`);
    }
    const block = await ports.allocate(`baseline-${t.agent}`);
    agents.push({
      task: t, worktree: fs.realpathSync(worktree), branch, sessionId: randomUUID(), configDir: path.join(home.root, 'baseline', t.agent, 'claude-config'),
      ports: block, child: null, integratedAt: null, attempts: 0, testedOnce: false, lastOutcome: null, relay: null,
    });
  }
  rec.log(`baseline: worktrees ${agents.map((a) => `${a.task.agent} (${a.branch})`).join(', ')} ready, setup done`);

  // The clock starts as both agents get their cards (M1).
  const firstPrompt = new Map<string, string>();
  for (const a of agents) {
    const promptFile = path.join(b.root, 'prompts', `${a.task.agent}.txt`);
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    firstPrompt.set(a.task.agent, b.prompt(a.task, a.worktree));
    fs.writeFileSync(promptFile, firstPrompt.get(a.task.agent)!);
  }
  rec.mark('started', { arm: 'baseline', launch: b.launch });
  const clockStart = rec.ms();
  for (const a of agents) {
    rec.mark('assigned', { task: a.task.key, agent: a.task.agent, branch: a.branch });
    const cmd = [`cd ${sq(b.harnessRoot)}`, `HARNESS_HOME=${sq(home.root)} node scripts/ab/baseline-launch.ts --worktree ${sq(a.worktree)} --repo ${sq(repo)} --agent ${a.task.agent} --ports ${a.ports.base}:${a.ports.count} --session-id ${a.sessionId} --prompt-file ${sq(path.join(b.root, 'prompts', `${a.task.agent}.txt`))}`].join(' && ');
    if (b.launch === 'headless') {
      const env = b.mockUrl ? { ...process.env, ANTHROPIC_API_KEY: DUMMY_KEY } : process.env;
      const spec = { ...await baselineSpec({ worktree: a.worktree, repo, agent: a.task.agent, ports: a.ports, home, env }), sessionId: a.sessionId };
      const run = b.mockUrl ? { ...spec, auth: { mode: 'api-key' as const, apiKey: DUMMY_KEY, baseUrl: b.mockUrl }, model: { id: 'claude-haiku-4-5' } } : spec;
      const launch = new ClaudeAdapter().interactiveLaunch(run);
      a.child = spawn('python3', ['-c', PTY, path.join(rec.dir, `terminal-${a.task.agent}.log`), launch.command, ...launch.args, firstPrompt.get(a.task.agent)!],
        { cwd: launch.cwd, env: { ...launch.env, BROWSER: '/usr/bin/true' }, stdio: ['pipe', 'ignore', 'ignore'] });
      rec.log(`baseline: started agent ${a.task.agent} in a pseudo-terminal`);
    } else if (b.launch === 'terminal') {
      const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}`;
      execFileSync('osascript', ['-e', script]);
      rec.log(`baseline: opened a Terminal window for agent ${a.task.agent}`);
    } else {
      rec.log(`baseline: in a new terminal, run for agent ${a.task.agent}:\n  ${cmd}`);
    }
  }

  const marks: { what: string; t: number; task?: string; detail?: Record<string, unknown> }[] = [];
  const mark = (what: string, a: Agent, detail: Record<string, unknown> = {}) => {
    rec.mark(what, { task: a.task.key, agent: a.task.agent, ...detail });
    marks.push({ what, t: rec.ms(), task: a.task.key, detail });
  };
  let actions = 0;
  const byName = (name: string) => {
    const a = agents.find((x) => x.task.agent === name.trim().replace(/^agent\//, ''));
    if (!a) throw new Error(`no agent "${name}"; the agents are ${agents.map((x) => x.task.agent).join(', ')}`);
    return a;
  };

  /**
   * `merge <agent> [--no-tests]`: the land step without fencing. Commits the agent's work, merges it into main in
   * an integration worktree, tests there (unless `--no-tests`), and moves main only if green.
   */
  const merge = async (a: Agent, o: { tests: boolean } = { tests: true }): Promise<string> => {
    actions++;
    a.attempts++;
    await commitAll(a.worktree, `${a.task.title}\n\nAB-Task: ${a.task.key}`, COORDINATOR);
    const head = await branchTip(repo, a.branch);
    const base = await branchTip(repo, 'main');
    const dir = path.join(b.root, 'integration', `${a.task.agent}-${a.attempts}`);
    await addIntegrationWorktree(repo, dir, base);
    // Every integration mark says what was merged and when it started: the grader's first-attempt tree (§9).
    const start = rec.ms();
    const integrated = (detail: Record<string, unknown> & { outcome: string }) => {
      a.lastOutcome = detail.outcome;
      mark('integration', a, { ...detail, start, base, head, tests: o.tests });
    };
    try {
      const m = await mergeCommit(dir, head, `Merge ${a.branch}: ${a.task.title}`);
      if (!m.ok) { integrated({ outcome: 'conflict', conflicts: m.conflicts }); return `conflict in ${m.conflicts.join(', ')}; main is unchanged. Tell the agent, \`sync ${a.task.agent}\`, and merge again once it has fixed it`; }
      const repoCfg = readRepoConfig(dir);
      if (repoCfg.setup) {
        const s = await setupCmd(dir, repoCfg.setup.command, `integration-${a.task.agent}-${a.attempts}`, false);
        if (s.exitCode !== 0) { integrated({ outcome: 'setup_failed' }); return `the setup command failed (exit ${s.exitCode}); main is unchanged`; }
      }
      if (repoCfg.test && o.tests) {
        const log = path.join(home.logs, `baseline-test-${a.task.agent}-${a.attempts}.log`);
        const r = await setupCmd(dir, repoCfg.test.command, `test-${a.task.agent}-${a.attempts}`, true);
        const first = !a.testedOnce;
        a.testedOnce = true;
        if (r.exitCode !== 0) {
          const tail = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').slice(-20).join('\n') : '';
          integrated({ outcome: 'tests_failed', first, exit: r.exitCode });
          return `tests failed (${r.timedOut ? 'timed out' : `exit ${r.exitCode}`}); main is unchanged. The output's end:\n${tail}`;
        }
      }
      const adv = await advanceBase(repo, 'main', base, m.commit);
      if (!adv.ok) { integrated({ outcome: 'base_moved', detail: adv.detail }); return `main couldn't move: ${adv.detail}`; }
      a.integratedAt = rec.ms();
      integrated({ outcome: 'merged', commit: m.commit, first: a.attempts === 1 });
      return `merged into main (${m.commit.slice(0, 12)})${o.tests ? ', tests green' : ', tests skipped (--no-tests)'}`;
    } finally {
      await removeIntegrationWorktree(repo, dir).catch(() => {});
    }
  };
  /** `sync <agent>`: main into the agent's branch, so it has what's already integrated (harnessd's sync). */
  const sync = async (a: Agent): Promise<string> => {
    actions++;
    const r = await syncWorktree({ worktree: a.worktree, target: await branchTip(repo, 'main'), taskId: a.task.key, agent: COORDINATOR });
    mark('sync', a, r.ok ? { outcome: 'synced', changed: r.changed } : { outcome: 'conflict', conflicts: r.conflicts });
    return r.ok ? (r.changed.length ? `synced: ${r.changed.length} file(s) from main` : 'already up to date') : `conflicts in ${r.conflicts.join(', ')}; the branch is unchanged`;
  };
  if (b.console) {
    b.console.commands.merge = {
      usage: '<agent> [--no-tests]',
      run: (args) => {
        const words = args.trim().split(/\s+/);
        const noTests = words.includes('--no-tests');
        return merge(byName(words.filter((w) => w !== '--no-tests').join(' ')), { tests: !noTests });
      },
    };
    b.console.commands.sync = { usage: '<agent>', run: (args) => sync(byName(args)) };
    rec.log(`baseline: ${b.console.help()}`);
  }

  // Until both tasks are integrated, the cap, or the coordinator stops it.
  const deadline = Date.now() + b.capMs;
  let outcome: RunSummary['outcome'] = 'error';
  for (;;) {
    if (agents.every((a) => a.integratedAt !== null)) { outcome = 'integrated'; break; }
    if (b.stopRequested() || b.console?.stopRequested) { outcome = 'stopped'; break; }
    if (Date.now() > deadline) { outcome = 'capped'; break; }
    if (b.autoIntegrate) {
      for (const a of agents) {
        if (a.integratedAt !== null) continue;
        if (a.relay) {
          // Wait until the agent has the message typed into its terminal, then for that turn to end.
          if (readTranscript(sessionLines(a.configDir, a.sessionId)).prompts.length > a.relay.prompts) a.relay = null;
          else if (Date.now() - a.relay.at > 60_000) { rec.log(`baseline: ${a.task.agent} never took the message typed into its terminal; stopping`); outcome = 'stopped'; break; }
          else continue;
        }
        if (!turnEnded(a.configDir, a.sessionId, 4000)) continue;
        if (a.attempts >= 3) { rec.log(`baseline: ${a.task.agent} can't be integrated after 3 attempts; stopping`); outcome = 'stopped'; break; }
        let result = await merge(a);
        rec.log(`merge ${a.task.agent} (auto): ${result.split('\n')[0]}`);
        if (a.integratedAt === null && untestedRetry(b.scenario, { anyIntegrated: agents.some((x) => x.integratedAt !== null), attempts: a.attempts, testsFailed: a.lastOutcome === 'tests_failed' })) {
          // D-124: the first task's change may need the other's to pass, so it goes in untested.
          result = await merge(a, { tests: false });
          rec.log(`merge ${a.task.agent} --no-tests (auto, D-124): ${result.split('\n')[0]}`);
        }
        if (a.integratedAt === null && a.child?.stdin?.writable) {
          // The robotic coordinator's fix request, typed into the agent's terminal as a human would.
          await sync(a);
          const text = `Integrating your work into main failed: ${result.replace(/\s+/g, ' ').slice(0, 1500)} Please fix your work so it integrates and the tests pass.`;
          // Typed, then Enter on its own, as a person would: Enter inside one burst of input reads as pasted text.
          a.relay = { at: Date.now(), prompts: readTranscript(sessionLines(a.configDir, a.sessionId)).prompts.length };
          a.child.stdin.write(text);
          await new Promise((r) => setTimeout(r, 500));
          a.child.stdin.write('\r');
          mark('relay', a, { chars: text.length, auto: true });
        }
      }
      if (outcome === 'stopped') break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  rec.log(`baseline: run ended: ${outcome}`);

  // After the end: stop both agents; commit what they left, for the judge's diffs (none of it reaches main).
  for (const a of agents) { a.child?.kill('SIGTERM'); killSession(a.sessionId); }
  await new Promise((r) => setTimeout(r, 1500));
  const commits: { key: string; commit: string | null }[] = [];
  for (const a of agents) {
    await commitAll(a.worktree, `Left at the end of the run\n\nAB-Task: ${a.task.key}`, COORDINATOR).catch(() => null);
    commits.push({ key: a.task.key, commit: await branchTip(repo, a.branch) });
  }
  const mainSha = git(repo, 'rev-parse', 'main');

  // The measurements (validation.md §9), from the timeline, Git and the transcripts.
  const facts = agents.map((a) => transcriptFiles(a.configDir).map((f) => readTranscript(fs.readFileSync(f, 'utf8').split('\n'))));
  const flat = facts.flat();
  const messagesAfterCards = facts.reduce((n, fs_) => n + Math.max(0, fs_.reduce((k, f) => k + f.prompts.length, 0) - 1), 0);
  const interrupts = flat.reduce((n, f) => n + f.interrupts, 0);
  const usage = transcriptUsage(flat, b.provider?.model?.prices ?? {});
  const merged = agents.map((a) => a.integratedAt).filter((x): x is number => x !== null).sort((x, y) => x - y);
  const allIn = merged.length === agents.length;
  const integrations = marks.filter((m) => m.what === 'integration');
  const model = b.provider ? `${b.provider.model?.id ?? 'vendor default'}${b.provider.name ? ` (${b.provider.name})` : ''}` : 'scripted';
  return {
    outcome, agents: agents.map((a) => ({ name: a.task.agent, configDir: a.configDir })), commits,
    attempts: integrations.map((m) => ({
      task: m.task!, start: Number(m.detail?.start), end: m.t, base: String(m.detail?.base), head: String(m.detail?.head),
      outcome: m.detail?.outcome === 'merged' || m.detail?.outcome === 'tests_failed' || m.detail?.outcome === 'conflict' ? m.detail.outcome : 'other',
    })),
    summary: {
      v: 1, arm: 'baseline', scenario: b.scenario, outcome, models: [model],
      m1_ms: allIn ? merged.at(-1)! - clockStart : null,
      // M3: each task's first textual conflict with the other's integrated work, at a merge or a sync (§9).
      m3_conflicts: new Set(marks.filter((m) => (m.what === 'integration' || m.what === 'sync') && m.detail?.outcome === 'conflict').map((m) => m.task)).size,
      sync_conflicts: marks.filter((m) => m.what === 'sync' && m.detail?.outcome === 'conflict').length,
      m4: { commits_after_first: commitsAfterFirst(repo, baseSha, mainSha, merged.length), ms_to_green: allIn ? merged.at(-1)! - merged[0]! : null },
      // The runner's own fix requests in a rehearsal are typed into the terminal, so the transcripts count them like a human's.
      m5: messagesAfterCards + interrupts,
      m5b: flat.reduce((n, f) => n + f.denied, 0),
      m5c: actions,
      m7: messagesAfterCards ? { human_to_agent: messagesAfterCards } : {},
      m8: { input: usage.input, output: usage.output, cache_read: usage.cache_read, cache_creation: usage.cache_creation, cost_usd: usage.cost_usd },
      m9a: integrations.filter((m) => m.detail?.outcome === 'tests_failed' && m.detail.first === true).length,
      m10_ms: b.console?.m10Ms() ?? 0,
      surfaced: null, base_sha: baseSha, main_sha: mainSha,
      tasks: agents.map((a) => ({ key: a.task.key, agent: a.task.agent, branch: a.branch, integrated_at: a.integratedAt === null ? null : new Date(rec.t0 + a.integratedAt).toISOString() })),
    },
  };
}
