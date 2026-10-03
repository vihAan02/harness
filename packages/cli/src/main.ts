#!/usr/bin/env node
// `harness`, the human CLI (D-54; docs/architecture.md §2). It reads ~/.harness (HARNESS_HOME) for the
// server, the local token and the human principal, the same files harnessd uses.
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Approvals, computeMetrics, harnessHome, loadConfig, renderHumanStatus, renderMetrics, type ApprovalRequest, type LocalConfig } from '@harness/daemon';
import { PROTOCOL_VERSION, type EventMessage } from '@harness/protocol';
import pkg from '../package.json' with { type: 'json' };
import { CliClient, CliError } from './client.ts';

const USAGE = `usage: harness <command> [--project <id>]

  agent add <name> [--vendor claude]          register an agent you're accountable for (agent/<name>)
  task add <title> --scope <paths> [--assign <agent>] [--priority <n>] (--text <text> | --file <path>)
                                              write a task; --scope is comma-separated folders (src/api/) and files
  task assign <task> <agent>                  assign an open task; harnessd on the agent's device starts it
  task done <task> [--summary <text>]         mark a task done; harnessd commits its work and stops the agent
  task abandon <task> --reason <text>         abandon a task; harnessd stops the agent and removes the worktree
  status                                      agents, tasks, what each agent is changing, overlaps, questions
  log [--follow] [--kind <prefix>]            the project's event log
  metrics [--json]                            A/B metrics for this run, from the event log (validation.md §4)
  approve [<id>] [--yes]                      review and approve a repo's setup command (D-52)
  --version`;

type Args = { positional: string[]; flags: Record<string, string | true> };
function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { out.positional.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; } else out.flags[key] = true;
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
  const config = loadConfig(harnessHome());
  const c = await CliClient.connect(config, projectOf(config, a));
  try { return await fn(c); } finally { c.close(); }
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
      const r = await c.command('task.create', {
        title, text, scope, ...(assignee ? { assignee_agent_id: agentId(c, assignee) } : {}), ...(priority ? { priority: Number(priority) } : {}),
      });
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
      await c.command('task.assign', { task_id: task, assignee_agent_id: agentId(c, agent) });
      console.log(`Assigned ${task} to ${agentName(agent)}. harnessd on its device starts it now.`);
    });
  }

  if (command === 'task' && sub === 'done') {
    const task = rest[0] ?? fail('usage: harness task done <task> [--summary <text>]');
    const summary = flag(a, 'summary');
    return withServer(a, async (c) => {
      await c.command('task.complete', { task_id: task, ...(summary ? { summary } : {}) });
      console.log(`${task} is done. harnessd commits its work on harness/task/${task} and stops its agent.`);
    });
  }

  if (command === 'task' && sub === 'abandon') {
    const task = rest[0] ?? fail('usage: harness task abandon <task> --reason <text>');
    const reason = flag(a, 'reason') ?? fail('say why with --reason');
    return withServer(a, async (c) => {
      await c.command('task.abandon', { task_id: task, reason });
      console.log(`${task} is abandoned. harnessd stops its agent and removes its worktree.`);
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

/** D-52: the local human approves a repo's setup command (and its manifests) before harnessd runs it. */
async function approve(args: string[]) {
  const approvals = new Approvals(harnessHome());
  const id = args.find((a) => !a.startsWith('-'));
  const pending = approvals.pending();
  if (!id) {
    if (pending.length === 0) return console.log('No setup commands are waiting for approval.');
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
  console.log(`Approved ${req.id}. harnessd will run it in the sandbox: writes only in the worktree, no secrets, network limited to your allowlist.`);
}

function describe(r: ApprovalRequest) {
  console.log(`\n${r.id}  project ${r.projectId}, first requested for task ${r.taskId}`);
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
