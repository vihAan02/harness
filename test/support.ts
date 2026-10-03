// A whole local harness for end-to-end tests: a real coordination server on a throwaway schema, a
// real harnessd, the real pinned Claude Code CLI behind ClaudeAdapter, and the scripted mock standing in
// for the model (so no API key is needed, D-56). The daemon and server packages may not import each
// other, so this lives outside both.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Daemon, type DaemonOptions, type RunningAgent } from '../packages/daemon/src/daemon.ts';
import { parseConfig } from '../packages/daemon/src/config.ts';
import { makeRepo, tempDir, tempHome, TOKEN } from '../packages/daemon/test/fixtures.ts';
import type { Home } from '../packages/daemon/src/home.ts';
import { startServer, type RunningServer } from '../packages/server/src/server.ts';
import { TestClient } from '../packages/server/test/client.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from '../packages/server/test/helpers.ts';
import { DUMMY_KEY, startMock, type Mock } from '../packages/adapters/test/mock-api.ts';
import type { Observation } from '../packages/adapters/src/adapter.ts';
import type { EventMessage } from '../packages/protocol/src/index.ts';

export type Stack = Awaited<ReturnType<typeof startStack>>;

export async function startStack(p: { files: Record<string, string>; portRange?: [number, number]; daemon?: boolean; daemonOptions?: Partial<DaemonOptions> }) {
  const db = await freshSchema();
  const project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_test', 'human_test', 'laptop')");
  const errors: unknown[] = [];
  const server: RunningServer = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: TOKEN, port: 0, onError: (e) => errors.push(e) });
  const mock: Mock = await startMock();
  const systemPrompts: string[] = [];
  const requestTools: string[][] = [];
  mock.onMain = (body) => {
    systemPrompts.push((body.system as { text: string }[]).map((b) => b.text).join('\n'));
    requestTools.push((body.tools as { name: string }[]).map((x) => x.name).sort());
  };
  const t = tempDir('stack');
  const { repo, sha } = makeRepo(t.dir, p.files);

  // The human's CLI connection.
  const human = await TestClient.open(server.url);
  human.send({ v: 1, type: 'hello', client: { kind: 'cli', version: '0' }, principal: 'human_test', auth: { scheme: 'local-token', token: TOKEN }, subscribe: [{ project_id: project, after_seq: 0 }] });
  await human.next('welcome');
  const command = async (name: string, args: Record<string, unknown>): Promise<Record<string, string>> => {
    const command_id = randomUUID();
    human.send({ v: 1, type: 'command', command_id, project_id: project, name, args });
    const r = await human.next('command_result', (m) => m.command_id === command_id, 10_000);
    if (!r.ok) throw new Error(`${name}: ${r.error.code}: ${r.error.message}`);
    return (r.result ?? {}) as Record<string, string>;
  };

  const home: Home = tempHome(t.dir);
  const range = p.portRange ?? [31400, 31499];
  // The same config on disk, for the CLI (it reads HARNESS_HOME like harnessd does).
  fs.writeFileSync(home.config, [
    'device_id = "dev_test"', 'principal = "human_test"', `server_url = "${server.url}"`,
    '[limits]', `port_range = [${range[0]}, ${range[1]}]`,
    '[[projects]]', `id = "${project}"`, `repo = "${repo}"`, '',
  ].join('\n'));
  const config = parseConfig({
    device_id: 'dev_test', principal: 'human_test', server_url: server.url,
    limits: { port_range: range }, projects: [{ id: project, repo }],
  }, TOKEN);
  const observed: { run: RunningAgent; o: Observation; t: number }[] = [];
  const acted: EventMessage[] = [];
  const logs: string[] = [];
  const daemon = new Daemon({
    home, config, heartbeatMs: 200,
    auth: { mode: 'api-key', apiKey: DUMMY_KEY, baseUrl: mock.url },
    onObservation: (run, o) => observed.push({ run, o, t: Date.now() }),
    onEvent: (e) => acted.push(e),
    log: (m) => logs.push(m),
    ...p.daemonOptions,
  });
  if (p.daemon !== false) {
    await daemon.start();
    await daemon.ready();
  }

  const until = async (pred: () => boolean, ms = 30_000, what = 'condition') => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; observed: ${observed.map((s) => s.o.kind).join(', ')}; logs: ${logs.join(' | ')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  /** Events on the human's connection, in order, matching `pred`, waiting for each. */
  const nextEvent = (pred: (e: EventMessage) => boolean, ms = 30_000) => human.next('event', pred, ms);
  /** The text of every tool result in a session's conversation, in order, as of the mock's latest request containing `marker`. */
  const toolResults = (marker = '') => {
    const last = mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary).includes(marker)).at(-1);
    return ((last?.summary ?? []) as { blocks: { type: string; text?: string }[] }[]).flatMap((m) =>
      m.blocks.filter((b) => b.type === 'tool_result').map((b) => b.text ?? ''));
  };

  /** The id the next task.create will get (task ids come from one sequence, D-78), so scripts can name its worktree. */
  const nextTaskId = async () => {
    const r = (await db.pool.query<{ last_value: string; is_called: boolean }>('SELECT last_value, is_called FROM task_numbers')).rows[0]!;
    return `T-${r.is_called ? Number(r.last_value) + 1 : Number(r.last_value)}`;
  };
  const worktreeOf = (taskId: string) => daemon.worktreeOf(project, taskId);
  /** Waits for the nth turn end of the agent working on `taskId`. */
  const turnEnds = (taskId: string, n = 1, ms = 30_000) =>
    until(() => observed.filter((x) => x.run.taskId === taskId && x.o.kind === 'turn.ended').length >= n, ms, `${n} turn end(s) on ${taskId}`);
  /** Creates a task assigned to `agent`; harnessd starts the agent with `text` as its task (D-81). */
  const assignTask = async (agent: string, title: string, scope: string[], text: string) =>
    (await command('task.create', { title, text, scope, assignee_agent_id: agent })).task_id!;

  /** Runs the real `harness` CLI against this stack. */
  const cli = async (...args: string[]) => {
    const main = path.resolve(import.meta.dirname, '../packages/cli/src/main.ts');
    const { stdout } = await promisify(execFile)(process.execPath, [main, ...args], { env: { ...process.env, HARNESS_HOME: home.root } });
    return stdout;
  };

  const stop = async () => {
    await daemon.stop();
    human.close();
    await server.close();
    await mock.close();
    await db.drop();
    t.cleanup();
    if (errors.length) throw new Error(`server errors: ${errors.map(String).join('; ')}`);
  };
  return { cli, nextTaskId, worktreeOf, turnEnds, assignTask, db, project, server, mock, systemPrompts, requestTools, t, repo, sha, human, command, home, config, daemon, observed, acted, logs, until, nextEvent, toolResults, stop };
}

export const steps = (...s: string[]) => s.map((x) => `#STEP ${x}`).join('\n');
