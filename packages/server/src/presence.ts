// Device presence (D-75). harnessd sends a `heartbeat` message every few seconds. A heartbeat updates
// devices.last_heartbeat_at, and logs an event only when the device's presence in a project changes:
// `device.online` on the first heartbeat, `device.offline` when the sweeper finds it silent.
import type pg from 'pg';
import { inTransaction } from './db.ts';
import { appendEvents, notifyProject } from './events.ts';

export async function heartbeat(pool: pg.Pool, deviceId: string, principal: string, projectIds: string[]): Promise<void> {
  await pool.query('UPDATE devices SET last_heartbeat_at = now() WHERE id = $1', [deviceId]);
  for (const projectId of projectIds) {
    await inTransaction(pool, async (tx) => {
      const changed = await tx.query(
        `INSERT INTO device_presence (project_id, device_id, online) VALUES ($1, $2, true)
         ON CONFLICT (project_id, device_id) DO UPDATE SET online = true, changed_at = now() WHERE NOT device_presence.online
         RETURNING 1`, [projectId, deviceId]);
      if (!changed.rowCount) return;
      await appendEvents(tx, projectId, [{ kind: 'device.online', actor: principal, deviceId, data: { device_id: deviceId } }]);
      await notifyProject(tx, projectId);
    });
  }
}

/** Marks devices offline whose last heartbeat is older than `offlineAfterMs`, one event per project. */
export async function sweepOffline(pool: pg.Pool, offlineAfterMs: number): Promise<void> {
  const stale = (await pool.query<{ project_id: string; device_id: string }>(
    `SELECT p.project_id, p.device_id FROM device_presence p JOIN devices d ON d.id = p.device_id
     WHERE p.online AND (d.last_heartbeat_at IS NULL OR d.last_heartbeat_at < now() - make_interval(secs => $1))`,
    [offlineAfterMs / 1000])).rows;
  for (const { project_id: projectId, device_id: deviceId } of stale) {
    await inTransaction(pool, async (tx) => {
      // Re-check under the row lock: a heartbeat may have landed since the scan.
      const changed = await tx.query(
        `UPDATE device_presence p SET online = false, changed_at = now() FROM devices d
         WHERE p.project_id = $1 AND p.device_id = $2 AND p.online AND d.id = p.device_id
           AND (d.last_heartbeat_at IS NULL OR d.last_heartbeat_at < now() - make_interval(secs => $3))
         RETURNING 1`, [projectId, deviceId, offlineAfterMs / 1000]);
      if (!changed.rowCount) return;
      await appendEvents(tx, projectId, [{ kind: 'device.offline', actor: 'harness', deviceId, data: { device_id: deviceId } }]);
      await notifyProject(tx, projectId);
    });
  }
}
