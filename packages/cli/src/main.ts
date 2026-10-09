#!/usr/bin/env node
// `harness`, the human CLI (D-54; docs/architecture.md §2). It reads ~/.harness (HARNESS_HOME) for the
// server, the local token and the human principal, the same files harnessd uses.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Approvals, computeMetrics, harnessHome, loadConfig, loadDeviceKey, renderHumanStatus, renderMetrics, untrustedText, type ApprovalRequest, type LocalConfig } from '@harness/daemon';
import { PROTOCOL_VERSION, type DispatchKind, type EventMessage } from '@harness/protocol';
import { taskSha256 } from '@harness/protocol/signing';
import pkg from '../package.json' with { type: 'json' };
import { CliClient, CliError } from './client.ts';
import { doctor, renderChecks } from './doctor.ts';
import { dispatchVia } from './harnessd.ts';
import { keygen, writeSetup } from './setup.ts';

const USAGE = `usage: harness <command> [--project <id>]

  agent add <name> [--vendor claude]          register an agent you're accountable for (agent/<name>)
  task add <title> --scope <paths> [--assign <agent>] [--priority <n>] (--text <text> | --file <path>)
                                              write a task; --scope is comma-separated folders (src/api/) and files
  task assign <task> <agent>                  assign an open task; harnessd on the agent's device starts it
  task done <task> [--summary <text>]         mark a task done; harnessd commits its work and stops the agent
  task abandon <task> --reason <text>         abandon a task; harnessd stops the agent and removes the worktree
  task reopen <task> (--text <msg> | --file <path>)
                                              send a done task back to its agent (a failed land, say): a new session
                                              in its worktree, with your message (D-107)
  task resume <task> [--text <msg> | --file <path>]
                                              start a stopped task again (its session ended): a new session in its
                                              worktree, with the work so far (D-113)
  task unblock <task>                         after you've resolved a sync conflict in the task's worktree: resume the agent
  land <task> [--no-tests] [--no-wait]        land a finished task: its device merges it, runs the approved test command,
                                              and moves the base branch only if green (D-51)
  land --cancel <task>                        give up on a land that hasn't started
  claim <task> <paths…> [--ttl <s>] [--force] a hard claim (lease) for a task: folders and files (spaces or commas);
                                              --force takes over another task's (D-89). Its harnessd renews it
  release <task> [<lease_id>…]                end a task's hard claims (all of them, or the ones named)
  status                                      agents, tasks, what each agent is changing, overlaps, questions
  log [--follow] [--kind <prefix>]            the project's event log
  metrics [--json]                            A/B metrics for this run, from the event log (validation.md §4)
  approve [<id>] [--yes]                      review and approve a repo's setup or test command (D-52)
  setup keygen [--device <id>]                make this Mac's device key once, and print its fingerprint to read aloud
  setup --device <id> --principal <human> --server-key ed25519:… --project <id> --repo <abs path>
        [--trust-device <id>=<human>:ed25519:…]… [--server-url ws://127.0.0.1:7400] [--base-branch main]
        [--integration github --remote <https url> --commit-name <name> --commit-email <noreply>]
        [--provider <name>] [--force]       write config.toml for the pilot (D-111): only the keys you typed are pinned
  doctor [--offline]                          check this Mac is ready for the pilot; prints each fix, never a secret
  --version`;

type Args = { positional: string[]; flags: Record<string, string | true> };
/** Flags that never take a value, so `harness claim T --force a b` keeps `a` as a path. */
const BOOLEAN_FLAGS = new Set(['force', 'no-tests', 'no-wait', 'follow', 'json', 'yes', 'version', 'offline']);
function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { out.positional.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; } else out.flags[key] = true;
  }
  return out;
}
const flag = (a: Args, k: string): string | undefined => (typeof a.flags[k] === 'string' ? a.flags[k] as string : undefined);

function fail(message: string): never {
  throw new CliError(message);
}

function projectOf(config: LocalConfig, a: Args): string {
  const chosen = flag(a, 'project');
  if (chosen) return chosen;
  if (config.projects.length === 1) return config.projects[0]!.id;
  fail(config.projects.length ? `several projects in your config; pick one with --project (${config.projects.map((p) => p.id).join(', ')})` : 'no [[projects]] in your config.toml');
}

const agentName = (n: string) => (n.startsWith('agent/') ? n : `agent/${n}`);

/** An agent by name (`backend`, `agent/backend`) or id, from the project's view. */
function agentId(c: CliClient, ref: string): string {
  const found = [...c.view.agents.values()].find((x) => x.id === ref || x.name === agentName(ref));
  if (!found) fail(`no agent ${ref} in this project; add one with: harness agent add <name>`);
  return found.id;
}

async function withServer<T>(a: Args, fn: (c: CliClient) => Promise<T>): Promise<T> {
  const home = harnessHome();
  const config = loadConfig(home);
  const c = await CliClient.connect(config, projectOf(config, a), undefined, config.auth === 'device-key' ? loadDeviceKey(home) : null);
  try { return await fn(c); } finally { c.close(); }
}

/**
 * A human's lifecycle command (D-112). With device keys, harnessd on this Mac signs it from its own view, with the
 * device key the CLI never reads, and sends it; the CLI first says what's being signed, as the task stands now.
 * On a loopback local-token stack it goes as before, with no dispatch.
 */
async function lifecycle(c: CliClient, kind: DispatchKind, name: string, taskId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = loadConfig(harnessHome());
  if (config.auth !== 'device-key') return c.command(name, { task_id: taskId, ...args });
  const t = c.view.tasks.get(taskId) ?? fail(`no task ${taskId} in this project`);
  const expected = { task_sha256: taskSha256({ title: t.title, text: t.text, scope: t.scope, owner_human_id: t.ownerHumanId }) };
  console.log(`Signing a ${kind} of ${taskId} "${untrustedText(t.title, 120)}" (scope ${t.scope.map((p) => untrustedText(p, 120)).join(', ') || 'none'}; task ${expected.task_sha256.slice(0, 12)}) with this Mac's key, through harnessd.`);
  const r = await dispatchVia(harnessHome(), { project_id: c.projectId, kind, task_id: taskId, args, expected, command_id: randomUUID() });
  return ((r as { result?: unknown } | null)?.result ?? {}) as Record<string, unknown>;
}

function describeEvent(c: CliClient, e: EventMessage): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const who = e.actor.principal === 'harness' ? 'harness' : e.actor.on_behalf_of ? c.view.agentName(e.actor.principal) : e.actor.principal;
  const skip = new Set(['text', 'task_id']);
  const name = (v: unknown) => (typeof v === 'string' && c.view.agents.has(v) ? c.view.agentName(v) : v);
  const detail = Object.entries(d).filter(([k]) => !skip.has(k)).map(([k, v]) => {
    const shown = Array.isArray(v) ? v.map(name) : name(v);
    return `${k}=${typeof shown === 'string' ? shown : JSON.stringify(shown)}`;
  }).join(' ');
  const text = typeof d.text === 'string' ? ` ${JSON.stringify(d.text.length > 80 ? `${d.text.slice(0, 80)}…` : d.text)}` : ''; // one line per event
  return `#${String(e.seq).padEnd(5)} ${e.at.slice(11, 19)}  ${who.padEnd(18)} ${e.kind.padEnd(20)} ${d.task_id ? `${String(d.task_id)} ` : ''}${detail}${text}`;
}

async function main(argv: string[]): Promise<void> {
  const a = parseArgs(argv);
  const [command, sub, ...rest] = a.positional;
  if (a.flags.version || command === '-v') return void console.log(`harness ${pkg.version} (protocol v${PROTOCOL_VERSION})`);

  if (command === 'approve') return approve(argv.slice(1));
  if (command === 'setup') return setup(a, argv);
  if (command === 'doctor') {
    const checks = await doctor(harnessHome(), { offline: a.flags.offline === true });
    console.log(renderChecks(checks));
    if (checks.some((c) => c.ok === false)) process.exitCode = 1;
    return;
  }

  if (command === 'agent' && sub === 'add') {
    const name = rest[0] ?? fail('usage: harness agent add <name>');
    return withServer(a, async (c) => {
      const r = await c.command('agent.create', { name: agentName(name), vendor: flag(a, 'vendor') ?? 'claude' });
      console.log(`Added ${agentName(name)} (${String(r.agent_id)}). Give it a task with: harness task add … --assign ${agentName(name)}`);
    });
  }

  if (command === 'task' && sub === 'add') {
    const title = rest.join(' ') || flag(a, 'title') || fail('usage: harness task add <title> --scope <paths> (--text <text> | --file <path>)');
    const file = flag(a, 'file');
    const text = file ? fs.readFileSync(file, 'utf8') : flag(a, 'text') ?? fail('give the task text with --text or --file');
    const scope = (flag(a, 'scope') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return withServer(a, async (c) => {
      const assignee = flag(a, 'assign');
      const priority = flag(a, 'priority');
      // With device keys a start dispatch names its task, and the server picks the id: create, then assign (D-112).
      const signed = loadConfig(harnessHome()).auth === 'device-key';
      const r = await c.command('task.create', {
        title, text, scope, ...(assignee && !signed ? { assignee_agent_id: agentId(c, assignee) } : {}), ...(priority ? { priority: Number(priority) } : {}),
      });
      if (assignee && signed) {
        await c.until((v) => v.tasks.has(String(r.task_id)));
        await lifecycle(c, 'start', 'task.assign', String(r.task_id), { assignee_agent_id: agentId(c, assignee) });
      }
      console.log(`Created ${String(r.task_id)}: ${title}${assignee ? `, assigned to ${agentName(assignee)}. harnessd on its device starts it now.` : '.'}`);
      for (const o of (r.overlaps as { task_id: string; paths: string[] }[] | undefined) ?? []) {
        console.log(`Heads-up: its scope overlaps ${o.task_id} on ${o.paths.join(', ')}. Agents work best with scopes that don't overlap.`);
      }
    });
  }

  if (command === 'task' && sub === 'assign') {
    const [task, agent] = rest;
    if (!task || !agent) fail('usage: harness task assign <task> <agent>');
    return withServer(a, async (c) => {
      await lifecycle(c, 'start', 'task.assign', task, { assignee_agent_id: agentId(c, agent) });
      console.log(`Assigned ${task} to ${agentName(agent)}. harnessd on its device starts it now, or, if it's another human's agent, once they approve it there (D-34).`);
    });
  }

  if (command === 'task' && sub === 'done') {
    const task = rest[0] ?? fail('usage: harness task done <task> [--summary <text>]');
    const summary = flag(a, 'summary');
    return withServer(a, async (c) => {
      await lifecycle(c, 'complete', 'task.complete', task, summary ? { summary } : {});
      console.log(`${task} is done. harnessd commits its work on harness/task/${task} and stops its agent.`);
    });
  }

  if (command === 'task' && sub === 'abandon') {
    const task = rest[0] ?? fail('usage: harness task abandon <task> --reason <text>');
    const reason = flag(a, 'reason') ?? fail('say why with --reason');
    return withServer(a, async (c) => {
      await lifecycle(c, 'abandon', 'task.abandon', task, { reason });
      console.log(`${task} is abandoned. harnessd stops its agent and removes its worktree.`);
    });
  }

  if (command === 'task' && sub === 'reopen') {
    const task = rest[0] ?? fail('usage: harness task reopen <task> (--text <message> | --file <path>)');
    const file = flag(a, 'file');
    const text = file ? fs.readFileSync(file, 'utf8') : flag(a, 'text') ?? fail('say what to fix with --text or --file (a failed land\'s output, say)');
    return withServer(a, async (c) => {
      await lifecycle(c, 'reopen', 'task.reopen', task, { text });
      console.log(`${task} is reopened. harnessd starts its agent again in its worktree, with your message.`);
    });
  }

  if (command === 'task' && sub === 'resume') {
    const task = rest[0] ?? fail('usage: harness task resume <task> [--text <message> | --file <path>]');
    const file = flag(a, 'file');
    const text = file ? fs.readFileSync(file, 'utf8') : flag(a, 'text');
    return withServer(a, async (c) => {
      await lifecycle(c, 'resume', 'task.resume', task, text ? { text } : {});
      console.log(`${task} is resumed. harnessd starts a new session in its worktree, with the work so far${text ? ' and your message' : ''} (D-113).`);
    });
  }

  if (command === 'task' && sub === 'unblock') {
    const task = rest[0] ?? fail('usage: harness task unblock <task>');
    return withServer(a, async (c) => {
      await c.command('task.unblock', { task_id: task });
      console.log(`${task} is unblocked. harnessd checks the worktree contains the new base, then resumes its agent.`);
    });
  }

  if (command === 'land') {
    const cancel = flag(a, 'cancel');
    if (cancel) {
      return withServer(a, async (c) => {
        await c.command('land.cancel', { task_id: cancel });
        console.log(`Cancelled the land of ${cancel}.`);
      });
    }
    const task = sub ?? fail('usage: harness land <task> [--no-tests] [--no-wait]');
    return withServer(a, async (c) => land(c, task, { tests: !a.flags['no-tests'], wait: !a.flags['no-wait'], timeoutMs: Number(flag(a, 'timeout') ?? 1800) * 1000 }));
  }

  if (command === 'claim') {
    const task = sub;
    const paths = rest.flatMap((p) => p.split(',')).map((p) => p.trim()).filter(Boolean);
    if (!task || !paths.length) fail('usage: harness claim <task> <paths…> [--ttl <s>] [--force]');
    if (a.flags.ttl === true) fail('--ttl needs a number of seconds, e.g. --ttl 300');
    const ttl = flag(a, 'ttl');
    return withServer(a, async (c) => {
      const r = await c.command('lease.acquire', {
        task_id: task, paths, ...(ttl ? { ttl_s: Number(ttl) } : {}), ...(a.flags.force ? { force: true } : {}),
      });
      const granted = r.granted as { lease_id: string; path: string; token: number; expires_at: string }[];
      const conflicts = r.conflicts as { path: string; lease_id: string; task_id: string; expires_at: string }[];
      if (!granted.length) {
        console.log(`Not granted. ${conflicts.map((x) => `${x.path} overlaps lease ${x.lease_id} of ${x.task_id} (until ${x.expires_at.slice(11, 19)} UTC)`).join('; ')}. Take it over with --force.`);
        process.exitCode = 1;
        return;
      }
      for (const g of granted) console.log(`${task} holds ${g.path}: lease ${g.lease_id}, token ${g.token}, until ${g.expires_at.slice(11, 19)} UTC unless its harnessd renews it.`);
    });
  }

  if (command === 'release') {
    const task = sub ?? fail('usage: harness release <task> [<lease_id>…]');
    return withServer(a, async (c) => {
      // Only the named task's leases: the server lets a human release any lease, so the CLI holds <task> to its word.
      const foreign = rest.filter((id) => c.view.leases.get(id)?.taskId !== task);
      if (foreign.length) fail(`${foreign.join(', ')} ${foreign.length === 1 ? 'is not a lease' : 'are not leases'} of ${task}; see harness status`);
      // With no ids: every lease of the task this view doesn't know has ended. The server decides which are still
      // current (one clock, F-84); this device's clock never filters them.
      const ids = rest.length ? rest : [...c.view.leases.values()].filter((l) => l.taskId === task && !l.releasedAt && !l.expiredAt).map((l) => l.id);
      if (!ids.length) return void console.log(`${task} holds no hard claims.`);
      const released: string[] = [];
      for (let i = 0; i < ids.length; i += 200) released.push(...(await c.command('lease.release', { lease_ids: ids.slice(i, i + 200) })).released as string[]);
      console.log(released.length ? `Released ${released.join(', ')}.` : 'Nothing to release: those leases had already ended.');
    });
  }

  if (command === 'status') return withServer(a, async (c) => void console.log(renderHumanStatus(c.view)));

  if (command === 'metrics') {
    return withServer(a, async (c) => {
      const m = computeMetrics(c.view);
      console.log(a.flags.json ? JSON.stringify(m, null, 2) : renderMetrics(m));
    });
  }

  if (command === 'log') {
    const kind = flag(a, 'kind');
    return withServer(a, async (c) => {
      const show = (e: EventMessage) => { if (!kind || e.kind.startsWith(kind)) console.log(describeEvent(c, e)); };
      for (const e of c.view.events) show(e);
      if (a.flags.follow) {
        c.onEvent = show;
        await c.closed;
      }
    });
  }

  console.error(USAGE);
  process.exitCode = 1;
}

/**
 * `harness land <task>` (D-51, D-54): asks the server, then follows the land on the log until it lands or
 * fails. The merge and tests run on the device that ran the task; its harnessd asks for approval of the
 * test command the first time, like setup (`harness approve`).
 */
async function land(c: CliClient, task: string, o: { tests: boolean; wait: boolean; timeoutMs: number }): Promise<void> {
  let landId = '';
  let settle: (code: number) => void = () => {};
  const finished = new Promise<number>((r) => { settle = r; });
  const backlog: EventMessage[] = [];
  const show = (e: EventMessage) => {
    const d = (e.data ?? {}) as Record<string, any>;
    if (!landId) { backlog.push(e); return; }
    if (d.land_id !== landId) return;
    if (e.kind === 'land.accepted') console.log(`Accepted: no lease conflicts on ${d.changed_paths?.length ?? 0} changed file(s). Merging in an integration worktree on its device…`);
    else if (e.kind === 'land.progress') console.log(`  ${d.step}${d.detail ? `: ${d.detail}` : ''}${d.step === 'awaiting_approval' ? ' (run `harness approve` on that device)' : ''}`);
    else if (e.kind === 'land.rejected') {
      const problems = (d.problems as any[]).map((p) => `  ${p.path || '(token)'}: ${p.reason}${p.lease_id ? ` (${p.lease_id})` : ''}`);
      console.error(['Rejected by the fencing check:', ...problems].join('\n'));
      settle(1);
    } else if (e.kind === 'land.completed') {
      console.log(`Landed ${task}: the base is now ${String(d.new_base_sha).slice(0, 12)}. ${d.changed_paths?.length ?? 0} file(s) changed; agents that read them are told (stale-context notices).`);
      settle(0);
    } else if (e.kind === 'land.failed') {
      console.error([
        `The land failed (${d.reason})${d.detail ? ':' : '.'}`,
        ...(d.detail ? [String(d.detail)] : []),
        ...(d.conflict_paths ? [`Conflicting files: ${d.conflict_paths.join(', ')}`] : []),
        "The task stays done; the base branch didn't move.",
      ].join('\n'));
      settle(1);
    }
  };
  c.onEvent = show;
  const r = await c.command('land.request', { task_id: task, run_tests: o.tests });
  landId = String(r.land_id);
  console.log(`Landing ${task} (${landId}) on device ${String(r.device_id)}${o.tests ? '' : ', without running tests'}.`);
  for (const e of backlog.splice(0)) show(e);
  if (!o.wait) return;
  const timer = setTimeout(() => { console.error(`Still landing after ${o.timeoutMs / 1000} s; follow it with: harness log --follow --kind land`); settle(1); }, o.timeoutMs);
  const code = await Promise.race([finished, c.closed.then(() => { console.error('Lost the connection to the server.'); return 1; })]);
  clearTimeout(timer);
  process.exitCode = code;
}

/** `harness setup keygen` and `harness setup …` (PB1; D-111): one Mac joins the pilot. */
function setup(a: Args, argv: string[]) {
  const home = harnessHome();
  if (a.positional[1] === 'keygen') return void console.log(keygen(home, flag(a, 'device')));
  if (a.positional.length > 1) fail('usage: harness setup keygen, or harness setup --device … (see harness --help)');
  const need = (k: string) => flag(a, k) ?? fail(`harness setup needs --${k}`);
  const integration = flag(a, 'integration') ?? 'github';
  if (integration !== 'github' && integration !== 'local') fail('--integration must be github or local');
  const file = writeSetup(home, {
    device: need('device'), principal: need('principal'), serverUrl: flag(a, 'server-url') ?? 'ws://127.0.0.1:7400', serverKey: need('server-key'),
    trust: argv.flatMap((x, i) => (argv[i - 1] === '--trust-device' ? [x] : [])), // repeatable
    project: need('project'), repo: need('repo'), baseBranch: flag(a, 'base-branch') ?? 'main', integration,
    remote: flag(a, 'remote'), commitName: flag(a, 'commit-name'), commitEmail: flag(a, 'commit-email'), provider: flag(a, 'provider'),
    force: a.flags.force === true,
  });
  console.log(`wrote ${file}. Next: harness doctor`);
}

/** D-52: the local human approves a repo's setup command (and its manifests) before harnessd runs it. */
async function approve(args: string[]) {
  const approvals = new Approvals(harnessHome());
  const id = args.find((a) => !a.startsWith('-'));
  const pending = approvals.pending();
  if (!id) {
    if (pending.length === 0) return console.log('No setup or test commands are waiting for approval.');
    for (const r of pending) describe(r);
    return console.log('Approve one with: harness approve <id>');
  }
  const matches = pending.filter((r) => r.id.startsWith(id));
  if (matches.length !== 1) {
    console.error(matches.length ? `${id} matches more than one request; use more of the id.` : `No pending approval ${id}.`);
    process.exitCode = 1;
    return;
  }
  const req = matches[0]!;
  describe(req);
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) {
      console.error('Not a terminal: pass --yes to approve without a prompt.');
      process.exitCode = 1;
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Approve this command? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Not approved.');
  }
  approvals.approve(req.id);
  console.log(req.kind === 'test'
    ? `Approved ${req.id}. harnessd will run it in the sandbox when landing: writes only in the integration worktree, no secrets, no network but local ports.`
    : `Approved ${req.id}. harnessd will run it in the sandbox: writes only in the worktree, no secrets, network limited to your allowlist.`);
}

function describe(r: ApprovalRequest) {
  console.log(`\n${r.id}  ${r.kind === 'test' ? 'TEST command (runs when a task lands)' : 'setup command'}; project ${r.projectId}, first requested for task ${r.taskId}`);
  console.log(`  command:   ${r.command}`);
  for (const m of r.manifests) console.log(`  manifest:  ${m.path}  ${m.sha256 ? m.sha256.slice(0, 12) : '(absent)'}`);
  console.log('  This command comes from the repo, so anyone who can commit can change it. Approving covers exactly this text and these manifests.\n');
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  console.error(`harness: ${(e as Error).message}`);
  process.exitCode = 1;
}
