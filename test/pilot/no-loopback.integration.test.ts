// D-143 (TH-22, D-119): a device can give its agents no port block (`[limits] ports_per_agent = 0`). Their sandbox then
// has no allowLocalBinding, so an agent's shell can't connect to any loopback service, a password-less Postgres
// included; and a land's tests, which are agent-written code, run without loopback access too. Each refusal has its
// control: the same probe from a device that hands out ports connects. The real pinned Claude Code CLI runs the probe
// in its own sandbox, scripted by the mock model, so this needs no API key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { startStack, steps, type Stack } from '../support.ts';

const j = (o: unknown) => JSON.stringify(o);
const dataOf = (e: { data: unknown }) => e.data as Record<string, unknown>;

let listener: net.Server;
let port = 0;
/** A one-line probe of the loopback listener: CONNECTED and exit 0, or REFUSED <code> and exit 3. */
const probe = () => `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('LOOPBACK-CONNECTED');process.exit(0)}).on('error',e=>{console.log('LOOPBACK-REFUSED '+e.code);process.exit(3)})"`;

before(async () => {
  listener = net.createServer((c) => c.end());
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', () => r()));
  port = (listener.address() as net.AddressInfo).port;
});
after(async () => {
  await new Promise<void>((r) => listener.close(() => r()));
});

/** A stack whose harness.yaml tests are the probe, with a human who approves every command as it's asked for. */
async function stack(portRange: [number, number], portsPerAgent?: number): Promise<{ s: Stack; done: () => Promise<void> }> {
  const s = await startStack({
    portRange, ...(portsPerAgent !== undefined ? { portsPerAgent } : {}),
    files: { 'src/app.ts': 'export const app = 1;\n', 'package.json': '{"name":"loopback"}\n', 'harness.yaml': `test:\n  command: ${probe()}\n  manifests: [package.json]\n` },
  });
  const approver = setInterval(() => { const a = new Approvals(s.home); for (const r of a.pending()) a.approve(r.id); }, 100);
  return { s, done: async () => { clearInterval(approver); await s.stop(); } };
}

/** An agent runs the probe, echoes its port variables and writes a file; returns the tool results. */
async function agentProbe(s: Stack, name: string): Promise<{ task: string; results: string[] }> {
  const agent = (await s.command('agent.create', { name, vendor: 'claude' })).agent_id!;
  const marker = `probed-${name.replace(/\W/g, '')}`;
  const task = await s.assignTask(agent, 'Probe loopback', ['src/'], steps(
    `Bash ${j({ command: probe() })}`,
    `Bash ${j({ command: 'echo "PORT=[$PORT] BASE=[$HARNESS_PORT_BASE]"' })}`,
    `Bash ${j({ command: "echo 'export const probed = 1;' > src/probe.ts" })}`, // something to commit, so the task can land
    `TEXT ${marker}`,
  ));
  await s.turnEnds(task, 1, 90_000);
  return { task, results: s.toolResults(marker) };
}

/** Finishes the task and lands it: harnessd runs the probe as the repo's test command, in the land's sandbox. */
async function land(s: Stack, task: string) {
  await s.command('task.complete', { task_id: task });
  await s.nextEvent((e) => e.kind === 'worktree.committed' && dataOf(e).task_id === task, 30_000);
  const r = await s.command('land.request', { task_id: task });
  return s.nextEvent((e) => ['land.completed', 'land.failed', 'land.rejected'].includes(e.kind) && dataOf(e).land_id === r.land_id, 90_000);
}

test('ports_per_agent = 0: the agent\'s shell can\'t reach a loopback listener, has no port variables, and the land\'s tests can\'t either', async () => {
  const { s, done } = await stack([31100, 31149], 0);
  try {
    const { task, results } = await agentProbe(s, 'agent/noports');
    assert.equal(results.length, 3, results.join('\n---\n'));
    assert.ok(!results[0]!.includes('LOOPBACK-CONNECTED'), results[0]);
    assert.match(results[0]!, /LOOPBACK-REFUSED E(PERM|ACCES)/, results[0]);
    assert.match(results[1]!, /PORT=\[\] BASE=\[\]/, 'no port block in its environment');
    assert.ok(!s.systemPrompts.at(-1)!.includes('Your ports are'), 'its instructions offer no ports');
    const out = await land(s, task);
    assert.deepEqual([out.kind, dataOf(out).reason], ['land.failed', 'tests'], j(dataOf(out)));
    assert.match(String(dataOf(out).detail), /LOOPBACK-REFUSED E(PERM|ACCES)/);
  } finally {
    await done();
  }
});

test('the control: with a port block (the default), the same probes connect, and the land passes', async () => {
  const { s, done } = await stack([31150, 31199]);
  try {
    const { task, results } = await agentProbe(s, 'agent/ports');
    assert.equal(results.length, 3, results.join('\n---\n'));
    assert.match(results[0]!, /LOOPBACK-CONNECTED/, results[0]);
    assert.match(results[1]!, /PORT=\[31150\] BASE=\[31150\]/);
    assert.ok(s.systemPrompts.at(-1)!.includes('Your ports are 31150'), 'its instructions name its ports');
    const out = await land(s, task);
    assert.equal(out.kind, 'land.completed', j(dataOf(out)));
  } finally {
    await done();
  }
});
