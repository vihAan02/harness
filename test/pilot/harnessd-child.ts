// harnessd as a child process, for crash tests (D-113): a real Daemon with the stand-in adapter (no vendor CLI), so a
// test can SIGKILL it mid-flight and start it again on the same home. Configured by HARNESS_CHILD (JSON). Writes one
// JSON line per log message, and {"ready":true} once caught up and recovered. SIGTERM stops it cleanly.
import { Daemon } from '../../packages/daemon/src/daemon.ts';
import { parseConfig } from '../../packages/daemon/src/config.ts';
import { harnessHome } from '../../packages/daemon/src/home.ts';
import { LockHeld } from '../../packages/daemon/src/lockfile.ts';
import { FakeAdapter } from '../fake-adapter.ts';

const c = JSON.parse(process.env.HARNESS_CHILD ?? '{}') as {
  home: string; raw: Record<string, unknown>; token: string; crashAt?: string;
  /** The pilot stack's GitHub mode: HARNESS_TEST=1 for the fake's hosts, its token, a short reconcile retry, no D-119 probe. */
  pilot?: { githubToken: string; retryMs: number };
};
const out = (m: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(m)}\n`);
const daemon = new Daemon({
  home: harnessHome(c.home), config: parseConfig(c.raw, c.token, c.pilot ? { env: { HARNESS_TEST: '1' } } : {}), heartbeatMs: 200,
  adapters: { claude: new FakeAdapter() }, auth: { mode: 'api-key', apiKey: 'unused-by-the-fake', baseUrl: 'http://127.0.0.1:9' },
  ...(c.crashAt ? { faults: { crashAt: c.crashAt } } : {}),
  ...(c.pilot ? {
    github: { token: async () => c.pilot!.githubToken, retryMs: c.pilot.retryMs }, pollMs: 200,
    localServices: { check: async () => [] }, // the stand-in adapter runs nothing in a sandbox (as in startPilotStack)
  } : {}),
  log: (m) => out({ log: m }),
});
try {
  await daemon.start();
} catch (e) {
  if (e instanceof LockHeld) {
    out({ locked: e.message });
    process.exit(75);
  }
  throw e;
}
await daemon.ready();
out({ ready: true });
process.once('SIGTERM', () => { void daemon.stop().then(() => process.exit(0)); });
