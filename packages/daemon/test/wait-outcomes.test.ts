// harnessd pushes a settled wait's outcome to the agent that waited (D-95, D-101), except one that wait.start
// resolved itself: the tool's result already said so. The server marks that one immediate, because the times
// of its wait.started and wait.resolved come from separate rows and can differ, even across a millisecond (#70).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventMessage } from '@harness/protocol';
import { Daemon, type RunningAgent } from '../src/daemon.ts';
import { parseConfig } from '../src/config.ts';
import { tempDir, tempHome, TOKEN } from './fixtures.ts';

test('a wait that wait.start resolved itself is never pushed, even when its two events straddle a millisecond (#70)', async () => {
  const t = tempDir('wait-outcomes');
  try {
    const config = parseConfig({ device_id: 'dev_test', principal: 'human_test', server_url: 'ws://127.0.0.1:1', projects: [{ id: 'prj', repo: t.dir }] }, TOKEN);
    const daemon = new Daemon({ home: tempHome(t.dir), config });
    let seq = 0;
    const ev = (kind: string, at: string, data: Record<string, unknown>): EventMessage =>
      ({ v: 1, type: 'event', project_id: 'prj', seq: ++seq, at, actor: { principal: 'harness', on_behalf_of: null, device_id: null }, kind, data });
    const on = { kind: 'task', id: 'T-2' };
    const view = daemon.view('prj');
    for (const [id, immediate] of [['wait_now', true], ['wait_later', false]] as const) {
      view.apply(ev('wait.started', '2026-10-06T12:00:00.999Z', { wait_id: id, task_id: 'T-1', session_id: 's1', agent_id: 'agent_a', on, timeout_at: '2026-10-06T12:10:00.000Z' }));
      view.apply(ev('wait.resolved', '2026-10-06T12:00:01.000Z', { wait_id: id, task_id: 'T-1', agent_id: 'agent_a', on, result: { status: 'done' }, ...(immediate ? { immediate: true } : {}) }));
    }
    const queued: string[] = [];
    const run = {
      sessionId: 's1', projectId: 'prj', taskId: 'T-1', agent: { id: 'agent_a', name: 'agent/a' }, handle: {},
      sync: { running: null, blocked: null },
      adapter: { queueNotice: async (_h: unknown, m: { id: string }) => { queued.push(m.id); return { landed: 'new_turn' }; } },
    } as unknown as RunningAgent;
    await daemon.deliverWait(run, view.waits.get('wait_now')!);
    await daemon.deliverWait(run, view.waits.get('wait_later')!);
    assert.deepEqual(queued, ['wait:wait_later'], 'only the wait the sweep settled is pushed');
  } finally {
    t.cleanup();
  }
});
