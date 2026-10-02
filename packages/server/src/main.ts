#!/usr/bin/env node
// Runs the coordination server on this machine: migrate, then serve on loopback (D-74).
import { createPool, migrate, DEFAULT_DATABASE_URL } from './db.ts';
import { startServer } from './server.ts';

const token = process.env.HARNESS_LOCAL_TOKEN;
if (!token || token.length < 32) {
  console.error('Set HARNESS_LOCAL_TOKEN to a random secret of at least 32 characters, e.g. `export HARNESS_LOCAL_TOKEN=$(openssl rand -hex 32)`.');
  process.exit(2);
}
const databaseUrl = process.env.HARNESS_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const pool = createPool(databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`migrated: ${applied.join(', ')}`);
const server = await startServer({ pool, databaseUrl, localToken: token, port: Number(process.env.HARNESS_PORT ?? 7400) });
console.log(`harness server listening on ${server.url}`);

const stop = async () => {
  await server.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
