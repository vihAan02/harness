// A whole local harness for end-to-end tests: a real coordination server on a throwaway schema, a
// real harnessd, the real pinned Claude Code CLI behind ClaudeAdapter, and the scripted mock standing in
// for the model (so no API key is needed, D-56). The daemon and server packages may not import each
// other, so this lives outside both. `startPilotStack` (below) is the two-Mac pilot's version: device keys, two
// humans, two harnessds, GitHub integration against the fake GitHub, and the stand-in adapter.
import { execFile } from 'node:child_process';
import { randomUUID, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { Daemon, type DaemonOptions, type RunningAgent } from '../packages/daemon/src/daemon.ts';
import { parseConfig, renderConfig, type LocalConfig } from '../packages/daemon/src/config.ts';
import { Handshake } from '../packages/daemon/src/identity.ts';
import { makeRepo, tempDir, tempHome, TOKEN } from '../packages/daemon/test/fixtures.ts';
import type { Home } from '../packages/daemon/src/home.ts';
import { startServer, type RunningServer } from '../packages/server/src/server.ts';
import { TestClient } from '../packages/server/test/client.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from '../packages/server/test/helpers.ts';
import { DUMMY_KEY, startMock, type Mock } from '../packages/adapters/test/mock-api.ts';
import type { Observation } from '../packages/adapters/src/adapter.ts';
import type { EventMessage, Subscription } from '../packages/protocol/src/index.ts';
import { generateKeyPair, parsePrivateKey } from '../packages/protocol/src/signing.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { FakeGitHub, type FakeGitHubOptions } from './fake-github.ts';

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

// ---------- the two-Mac pilot in one process (D-111, D-114, D-115) ----------

/** Async Git (the fake GitHub serves from this process, so nothing may block its event loop) with hooks off. */
export const gitAsync = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' })).stdout.trim();

/**
 * Two clones of the fake GitHub's repository, as two humans' Macs would have them: `<root>/a/repo` and `<root>/b/repo`.
 * Each trusts the fake's certificate and authenticates through repo-local config only (`http.<origin>/.sslCAInfo`, and a
 * credential helper that prints the token), so harnessd's restricted-env Git (git.ts: PATH, HOME, GIT_TERMINAL_PROMPT=0,
 * LC_ALL=C, hooks off) can fetch and push with no token in the remote URL (D-64, D-114). The empty `credential.helper`
 * first clears every helper from the user's own config, so no keychain ever stores a fake token.
 */
export async function makeRemotePair(root: string, fake: FakeGitHub): Promise<{ a: { repo: string }; b: { repo: string } }> {
  const helper = `!f() { test "$1" = get && echo username=x && echo password=${fake.token}; }; f`;
  const clone = async (side: 'a' | 'b') => {
    const repo = path.join(root, side, 'repo');
    fs.mkdirSync(path.dirname(repo), { recursive: true });
    await gitAsync(root, '-c', `http.sslCAInfo=${fake.caFile}`, '-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'clone', '-q', fake.gitUrl, repo);
    await gitAsync(repo, 'config', '--local', `http.${fake.webUrl}/.sslCAInfo`, fake.caFile);
    await gitAsync(repo, 'config', '--local', 'credential.helper', '');
    await gitAsync(repo, 'config', '--local', '--add', 'credential.helper', helper);
    return { repo };
  };
  return { a: await clone('a'), b: await clone('b') };
}

/** A human's CLI connection with device keys (D-111): hello, the server's challenge checked against the pinned key, the device's answer. */
export async function openDeviceClient(url: string, config: LocalConfig, deviceKey: KeyObject, subscribe: Subscription[]): Promise<TestClient> {
  const client = await TestClient.open(url);
  const hs = new Handshake({ config, deviceKey, clientKind: 'cli', subscribe });
  client.send(hs.hello());
  client.send(hs.answer(await client.next('challenge')));
  await client.next('welcome');
  return client;
}

export type PilotSide = {
  human: string; device: string; daemon: Daemon; home: Home; config: LocalConfig; repo: string; deviceKey: KeyObject; publicKey: string;
  adapter: FakeAdapter; client: TestClient; logs: string[]; acted: EventMessage[];
  /** Sends a command as this human from their device's CLI connection; throws on `ok: false`. */
  command: (name: string, args: Record<string, unknown>) => Promise<Record<string, string>>;
};
export type PilotStack = Awaited<ReturnType<typeof startPilotStack>>;

/**
 * The pilot on one machine: a coordination server with device keys on a throwaway schema; two humans (`human_a`,
 * `human_b`), each with a device (`dev_a`, `dev_b`) and its own Ed25519 key, both owners of one GitHub-mode project
 * (D-114); a fake GitHub; a clone each; and a harnessd each with its own home, key and config, which pins the server's
 * key and both devices (D-111, D-112). Agents run on the stand-in adapter, so no vendor CLI or model is needed and the
 * stack runs on Linux CI. Each human also has a CLI connection to send commands with.
 */
export async function startPilotStack(p: {
  files?: Record<string, string>; portRanges?: { a: [number, number]; b: [number, number] };
  daemons?: boolean; daemonOptions?: Partial<DaemonOptions>; fake?: FakeGitHubOptions;
  /** Options for one side's harnessd only, such as its UI socket. */
  sideOptions?: { a?: Partial<DaemonOptions>; b?: Partial<DaemonOptions> };
} = {}) {
  const cleanup: (() => Promise<void> | void)[] = [];
  const errors: unknown[] = [];
  const unwind = async () => {
    const failures: unknown[] = [];
    for (const f of cleanup.splice(0).reverse()) {
      try { await f(); } catch (e) { failures.push(e); }
    }
    if (failures.length) throw new AggregateError(failures, 'pilot stack teardown failed');
  };
  try {
    const db = await freshSchema();
    cleanup.push(() => db.drop());
    const project = `prj_${randomUUID().slice(0, 8)}`;
    const keys = { a: generateKeyPair(), b: generateKeyPair() };
    await db.pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_a', 'Human A'), ('human_b', 'Human B')");
    // A GitHub-mode project (D-114): the server decides, and harnessd refuses a config that disagrees.
    await db.pool.query("INSERT INTO projects (id, name, integration_mode, github_repo) VALUES ($1, $1, 'github', $2)", [project, `${p.fake?.owner ?? 'vihAan02'}/${p.fake?.repo ?? 'harness'}`]);
    await db.pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ($1, 'human_a', 'owner'), ($1, 'human_b', 'owner')", [project]);
    await db.pool.query("INSERT INTO devices (id, human_id, name, public_key) VALUES ('dev_a', 'human_a', 'mac-a', $1), ('dev_b', 'human_b', 'mac-b', $2)", [keys.a.publicKey, keys.b.publicKey]);
    const serverKey = generateKeyPair();
    const server = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, serverKey: parsePrivateKey(serverKey.privateKeyPem), port: 0, onError: (e) => errors.push(e) });
    cleanup.push(() => server.close());
    const fake = await FakeGitHub.start({ ...p.fake, ...(p.files ? { files: p.files } : {}) });
    cleanup.push(() => fake.close());
    const t = tempDir('pilot');
    cleanup.push(() => t.cleanup());
    const pair = await makeRemotePair(t.dir, fake);
    const ranges = p.portRanges ?? { a: [30400, 30499], b: [30500, 30599] };
    const trust = { dev_a: { human: 'human_a', key: keys.a.publicKey }, dev_b: { human: 'human_b', key: keys.b.publicKey } };

    const side = async (s: 'a' | 'b'): Promise<PilotSide> => {
      const human = `human_${s}`;
      const device = `dev_${s}`;
      const home = tempHome(path.join(t.dir, s));
      // On disk too, as `harness setup` leaves them, so the real CLI can run against this side (HARNESS_HOME = home.root).
      fs.writeFileSync(home.deviceKey, keys[s].privateKeyPem, { mode: 0o600 });
      const raw = {
        device_id: device, principal: human, server_url: server.url, auth: 'device-key', server_key: serverKey.publicKey,
        trust: { devices: trust }, limits: { port_range: ranges[s] }, agents: { max_budget_usd: 0.1, daily_budget_usd: 0.25 },
        projects: [{
          id: project, repo: pair[s].repo, integration: 'github', remote: fake.gitUrl, github_api: fake.apiUrl,
          commit_name: `Human ${s.toUpperCase()}`, commit_email: `${human}@users.noreply.github.com`,
        }],
      };
      const env = { env: { HARNESS_TEST: '1' } };
      fs.writeFileSync(home.config, renderConfig(raw, env));
      const config = parseConfig(raw, '', env);
      const deviceKey = parsePrivateKey(keys[s].privateKeyPem);
      const adapter = new FakeAdapter();
      const logs: string[] = [];
      const acted: EventMessage[] = [];
      const daemon = new Daemon({
        home, config, deviceKey, heartbeatMs: 200, adapters: { claude: adapter },
        auth: { mode: 'api-key', apiKey: DUMMY_KEY }, // never the environment's key: the stand-in adapter calls no model
        // The stand-in adapter runs nothing in a sandbox, so D-119's loopback-Postgres probe has nothing to protect here.
        localServices: { check: async () => [] },
        github: { token: async () => fake.token }, // the fake's token stands in for the human's gh login
        log: (m) => logs.push(m), onEvent: (e) => acted.push(e),
        ...p.daemonOptions, ...p.sideOptions?.[s],
      });
      cleanup.push(() => daemon.stop());
      const client = await openDeviceClient(server.url, config, deviceKey, [{ project_id: project, after_seq: 0 }]);
      cleanup.push(() => client.close());
      const command = async (name: string, args: Record<string, unknown>): Promise<Record<string, string>> => {
        const command_id = randomUUID();
        client.send({ v: 1, type: 'command', command_id, project_id: project, name, args });
        const r = await client.next('command_result', (m) => m.command_id === command_id, 10_000);
        if (!r.ok) throw new Error(`${human}: ${name}: ${r.error.code}: ${r.error.message}`);
        return (r.result ?? {}) as Record<string, string>;
      };
      return { human, device, daemon, home, config, repo: pair[s].repo, deviceKey, publicKey: keys[s].publicKey, adapter, client, logs, acted, command };
    };
    const a = await side('a');
    const b = await side('b');
    if (p.daemons !== false) {
      await Promise.all([a.daemon.start(), b.daemon.start()]);
      // ready() waits for as long as it takes (harnessd never gives up, TH-23); a stack that can't connect fails here instead.
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`harnessd not ready in 20 s: a ${a.daemon.linkState} (${a.logs.join(' | ')}); b ${b.daemon.linkState} (${b.logs.join(' | ')})`)), 20_000);
      });
      await Promise.race([Promise.all([a.daemon.ready(), b.daemon.ready()]), late]).finally(() => clearTimeout(timer));
    }

    const until = async (pred: () => boolean, ms = 30_000, what = 'condition') => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}; a: ${a.logs.join(' | ')}; b: ${b.logs.join(' | ')}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const stop = async () => {
      await unwind();
      if (errors.length) throw new Error(`server errors: ${errors.map(String).join('; ')}`);
    };
    return { db, project, server, serverKey: serverKey.publicKey, fake, t, a, b, until, stop };
  } catch (e) {
    await unwind().catch(() => {});
    throw e;
  }
}
