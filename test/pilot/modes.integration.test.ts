// The server decides how each project integrates (D-114): harnessd refuses to run a project whose config disagrees,
// since it would land that project's work the wrong way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Daemon } from '../../packages/daemon/src/daemon.ts';
import { parseConfig } from '../../packages/daemon/src/config.ts';
import { makeRepo, tempDir, tempHome, TOKEN } from '../../packages/daemon/test/fixtures.ts';
import { startServer } from '../../packages/server/src/server.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from '../../packages/server/test/helpers.ts';

const github = { integration: 'github', remote: 'https://github.com/o/r.git', commit_name: 'T', commit_email: 't@users.noreply.github.com' };

for (const [server, config] of [['local', 'github'], ['github', 'local'], ['github', 'github']] as const) {
  test(`server ${server}, config ${config}: ${server === config ? 'runs' : 'refused'}`, async () => {
    const db = await freshSchema();
    const project = await seedProject(db.pool);
    await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_test', 'human_test', 'laptop')");
    await db.pool.query('UPDATE projects SET integration_mode = $2 WHERE id = $1', [project, server]);
    const running = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: TOKEN, port: 0 });
    const t = tempDir('modes');
    const { repo } = makeRepo(t.dir, { 'README.md': 'x\n' });
    const daemon = new Daemon({
      home: tempHome(t.dir), log: () => {},
      config: parseConfig({ device_id: 'dev_test', principal: 'human_test', server_url: running.url, projects: [{ id: project, repo, ...(config === 'github' ? github : {}) }] }, TOKEN),
    });
    try {
      await daemon.start();
      if (server === config) await daemon.ready();
      else await assert.rejects(daemon.ready(), new RegExp(`config.toml says integration = "${config}", but the coordinator says "${server}"`));
    } finally {
      await daemon.stop();
      await running.close();
      await db.drop();
      t.cleanup();
    }
  });
}
