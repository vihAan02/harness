// harnessd's link to a coordinator that goes away and comes back (D-113): the durable outbox and the coordinator's
// epoch, against the real server and Postgres. A link stands in for harnessd, as harnessd's own reports use it.
// - A report made while the coordinator is down survives harnessd's stop; the next start sends it, once.
// - A resend of a command the server already ran acts once (D-74): its answer only clears it.
// - A report the server refuses goes to the outbox's dead/, with why, and isn't sent again.
// - A coordinator with another epoch (a new database) is never acted on: the link stops as coordinator_changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseConfig } from '../packages/daemon/src/config.ts';
import { Handshake } from '../packages/daemon/src/identity.ts';
import { ServerLink, type LinkState } from '../packages/daemon/src/link.ts';
import { Outbox } from '../packages/daemon/src/outbox.ts';
import { tempDir, TOKEN } from '../packages/daemon/test/fixtures.ts';
import { executeCommand } from '../packages/server/src/commands.ts';
import { startServer, type RunningServer } from '../packages/server/src/server.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from '../packages/server/test/helpers.ts';
import type { EventMessage } from '../packages/protocol/src/index.ts';

async function setup() {
  const db = await freshSchema();
  const project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_test', 'human_test', 'laptop')");
  const t = tempDir('outbox');
  const serve = (port = 0) => startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: TOKEN, port });
  let server: RunningServer = await serve();
  const port = Number(new URL(server.url).port);
  const config = parseConfig({ device_id: 'dev_test', principal: 'human_test', server_url: server.url, projects: [{ id: project, repo: t.dir }] }, TOKEN);
  const events: EventMessage[] = [];
  const states: LinkState[] = [];
  const link = (o: { acceptEpoch?: (e: string | null) => boolean } = {}) => new ServerLink({
    url: server.url, cursors: { [project]: 0 }, heartbeatMs: 200, outbox: new Outbox(path.join(t.dir, 'outbox')),
    handshake: (subscribe) => new Handshake({ config, deviceKey: null, clientKind: 'harnessd', subscribe }),
    onEvent: (e) => events.push(e), onState: (s) => states.push(s), ...o,
  });
  const until = async (pred: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
    for (const end = Date.now() + ms; !(await pred()); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  };
  const agents = async (name: string) => (await db.pool.query('SELECT count(*)::int AS n FROM agent_principals WHERE name = $1', [name])).rows[0].n as number;
  return {
    db, project, t, link, events, states, until, agents, outbox: () => new Outbox(path.join(t.dir, 'outbox')),
    down: async () => { await server.close(); },
    up: async () => { server = await serve(port); },
    done: async () => { await server.close().catch(() => {}); await db.drop(); t.cleanup(); },
  };
}

test('a report made while the coordinator is down survives harnessd\'s stop, and the next start sends it once', async () => {
  const s = await setup();
  try {
    const first = s.link();
    first.start();
    await first.whenReady();
    await s.down();
    const sent = first.command(s.project, 'agent.create', { name: 'agent/later', vendor: 'claude' }, undefined, undefined, true).then(() => 'answered', (e: Error) => e.message);
    assert.equal(s.outbox().load().length, 1, 'on disk before it is sent');
    await first.stop(); // harnessd stops while the coordinator is still down
    assert.equal(await sent, 'link stopped');
    assert.equal(s.outbox().load().length, 1, 'still waiting for the next start');
    assert.equal(await s.agents('agent/later'), 0);

    await s.up();
    const next = s.link();
    next.start();
    await s.until(async () => (await s.agents('agent/later')) === 1 && next.o.outbox!.pending() === 0, 'the report to arrive and be answered');
    await next.stop();
    assert.equal(s.outbox().load().length, 0);
    assert.equal(await s.agents('agent/later'), 1, 'once');
  } finally { await s.done(); }
});

test('a resend of a command the server already ran acts once; one the server refuses goes to dead/ and is never sent again', async () => {
  const s = await setup();
  try {
    // Ran, but the answer was lost with the connection: the outbox still has it.
    const ran = { v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: s.project, name: 'agent.create', args: { name: 'agent/once', vendor: 'claude' } };
    s.outbox().put(ran);
    await executeCommand(s.db.pool, { principal: 'human_test', deviceId: 'dev_test' }, ran);
    const link = s.link();
    link.start();
    await s.until(() => link.o.outbox!.pending() === 0, 'the resend to be answered');
    assert.equal(await s.agents('agent/once'), 1, 'the server ran it once');
    assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM events WHERE kind = 'agent.created' AND data->>'name' = 'agent/once'")).rows[0].n, 1);

    const refused = await link.command(s.project, 'agent.create', { name: 'not an agent name', vendor: 'claude' }, undefined, undefined, true).then(() => 'answered', (e: Error) => e.message);
    assert.match(refused, /^bad_request/);
    const dead = s.outbox().dead();
    assert.deepEqual(dead.map((d) => [d.name, d.error.split(':')[0]]), [['agent.create', 'bad_request']]);
    assert.equal(s.outbox().load().length, 0, 'not waiting to be sent again');
    await link.stop();
  } finally { await s.done(); }
});

test('a coordinator with another epoch is never acted on: the link stops as coordinator_changed, before any event', async () => {
  const s = await setup();
  try {
    await executeCommand(s.db.pool, { principal: 'human_test', deviceId: null }, { v: 1, type: 'command', command_id: randomUUID(), project_id: s.project, name: 'agent.create', args: { name: 'agent/a', vendor: 'claude' } });
    const epoch = (await s.db.pool.query('SELECT epoch FROM coordinator_epoch')).rows[0].epoch as string;
    const seen: (string | null)[] = [];
    const link = s.link({ acceptEpoch: (e) => { seen.push(e); return e === 'epoch_served_before'; } });
    link.start();
    await s.until(() => s.states.includes('coordinator_changed'), 'the link to stop');
    await link.running; // and it doesn't reconnect
    assert.deepEqual(seen, [epoch]);
    assert.equal(s.events.length, 0, 'nothing of the new coordinator reached harnessd');
    assert.equal(link.ready, false);
    await link.stop();
  } finally { await s.done(); }
});
