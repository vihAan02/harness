// A disconnect (acceptance 6; D-75, D-78): harnessd's connection to the coordinator drops while its agent works, as on a
// network change or a short sleep. What happened meanwhile is replayed once when it reconnects: a peer's message sent
// during the gap reaches the agent exactly once, the session isn't started again, and the agent's edits are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startPilotStack } from '../support.ts';

test('a dropped connection: the gap is replayed once, the session carries on, and the edits are kept', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, portRanges: { a: [30700, 30724], b: [30725, 30749] } });
  try {
    const mine = (await s.a.command('agent.create', { name: 'agent/steady', vendor: 'claude' })).agent_id!;
    const task = await s.a.assign(mine, { title: 'steady', text: 'Keep working.' });
    await s.until(() => s.a.daemon.running.has(task), 20_000, 'the session');
    const worktree = s.a.daemon.worktreeOf(s.project, task);
    fs.writeFileSync(path.join(worktree, 'notes.md'), 'kept\n');
    const sessions = s.a.adapter.sessions.length;
    const peer = (await s.b.command('agent.create', { name: 'agent/peer2', vendor: 'claude' })).agent_id!;
    const peerTask = await s.b.assign(peer, { title: 'peer', text: 'Ask a question.' });
    await s.until(() => s.b.daemon.running.has(peerTask), 20_000, 'the peer session');
    const seen = s.a.daemon.link!.seen[s.project]!;

    // The link drops (the socket closes under it) and B's agent asks A's a question in the gap.
    s.a.daemon.link!.ws!.close();
    await s.until(() => s.a.daemon.linkState !== 'connected', 10_000, 'the disconnect');
    const text = 'Which field holds the token?';
    await s.b.daemon.link!.command(s.project, 'message.send', { kind: 'question', to: 'agent/steady', text }, peer);

    await s.until(() => s.a.daemon.linkState === 'connected', 20_000, 'the reconnect');
    await s.until(() => s.a.adapter.of(task).injected.some((i) => i.text.includes(text)), 20_000, 'the question after the gap');
    await new Promise((r) => setTimeout(r, 600)); // three heartbeats: nothing arrives twice
    assert.equal(s.a.adapter.of(task).injected.filter((i) => i.text.includes(text)).length, 1, 'delivered once');
    assert.equal(s.a.adapter.sessions.length, sessions, 'no new session');
    assert.ok(s.a.daemon.running.has(task));
    assert.ok(s.a.daemon.link!.seen[s.project]! > seen, 'the gap was replayed');
    assert.equal(fs.readFileSync(path.join(worktree, 'notes.md'), 'utf8'), 'kept\n');
  } finally { await s.stop(); }
});
