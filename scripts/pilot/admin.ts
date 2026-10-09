#!/usr/bin/env node
// The coordinator operator's provisioning tool (PB1; D-111, acceptance 1): both humans join one project with no
// hand-written SQL.
//   npm run admin -- apply <pilot.toml> [--rotate <device_id>]… [--revoke <device_id>]…
//     Migrates the coordinator's database (HARNESS_DATABASE_URL), then applies the file in one transaction: humans,
//     devices and their public keys, projects, memberships, device-bound agents. A second run changes nothing; nothing
//     is ever deleted. Prints each device's fingerprint, for its human to read aloud.
//   npm run admin -- server-key
//     Creates the coordinator's key at HARNESS_SERVER_KEY_FILE once (owner-only, never overwritten) and prints its
//     public key and fingerprint, for every device to pin (`harness setup --server-key`).
// The pilot file holds public keys only. See docs/examples/pilot.toml.
import fs from 'node:fs';
import { parse } from 'smol-toml';
import { applyPilot, ensureServerKey, parsePilot } from '../../packages/server/src/admin.ts';
import { createPool, migrate } from '../../packages/server/src/db.ts';

const USAGE = 'usage: npm run admin -- apply <pilot.toml> [--rotate <device_id>]… [--revoke <device_id>]…\n       npm run admin -- server-key';

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'server-key') {
    const file = process.env.HARNESS_SERVER_KEY_FILE;
    if (!file) throw new Error('set HARNESS_SERVER_KEY_FILE to where the coordinator\'s private key lives (outside any repository)');
    const k = ensureServerKey(file);
    console.log(`${k.created ? 'created' : 'existing'} coordinator key ${file}`);
    console.log(`server_key = "${k.publicKey}"\n  fingerprint ${k.fingerprint}: read it aloud; each device pins it with harness setup --server-key`);
    return;
  }
  if (command !== 'apply') throw new Error(USAGE);
  const file = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--rotate' && rest[i - 1] !== '--revoke');
  if (!file) throw new Error(USAGE);
  const named = (flag: string) => rest.flatMap((a, i) => (rest[i - 1] === flag ? [a] : []));
  const spec = parsePilot(parse(fs.readFileSync(file, 'utf8')));
  const pool = createPool();
  try {
    const applied = await migrate(pool);
    if (applied.length) console.log(`migrated: ${applied.join(', ')}`);
    const report = await applyPilot(pool, spec, { rotate: named('--rotate'), revoke: named('--revoke') });
    console.log(report.changes.length ? report.changes.map((c) => `  ${c}`).join('\n') : '  nothing to change');
    console.log('device fingerprints (each human reads theirs aloud before anyone pins it):');
    for (const f of report.fingerprints) console.log(`  ${f.device_id.padEnd(24)} ${f.human.padEnd(20)} ${f.fingerprint}`);
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(`admin: ${e.message}`);
  process.exit(1);
});
