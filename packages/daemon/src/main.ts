#!/usr/bin/env node
// Runs harnessd in the foreground (D-75): `npm run daemon`. Ctrl-C stops it.
import path from 'node:path';
import { loadConfig, type LocalConfig } from './config.ts';
import { Daemon } from './daemon.ts';
import { harnessHome } from './home.ts';
import { LockHeld } from './lockfile.ts';
import { resolveProvider, type ResolvedProvider } from './provider.ts';

const home = harnessHome();
let config: LocalConfig;
try {
  config = loadConfig(home);
} catch (e) {
  console.error(`harnessd: ${(e as Error).message}`);
  process.exit(2);
}
// The model endpoint and key are checked now, not when the first task arrives (D-87).
let provider: ResolvedProvider;
try {
  provider = resolveProvider(config);
} catch (e) {
  console.error(`harnessd: ${(e as Error).message}`);
  process.exit(2);
}
// The UI bridge talks to harnessd over an owner-only socket in ~/.harness/run (D-117).
const daemon = new Daemon({ home, config, provider, uiSocket: path.join(home.run, 'harnessd.sock'), log: (m) => console.log(`harnessd: ${m}`) });
try {
  await daemon.start();
} catch (e) {
  // One harnessd per home (D-113): a second one never starts, and never touches the first one's agents.
  if (e instanceof LockHeld) {
    console.error(`harnessd: ${e.message}`);
    process.exit(75);
  }
  throw e;
}
console.log(`harnessd: device ${config.deviceId}, ${config.projects.length} project(s), server ${config.serverUrl}`);
console.log(`harnessd: agents run on ${provider.model?.id ?? "the vendor's default model"}${provider.name ? ` via provider "${provider.name}"` : ''}`);
void daemon.ready().then(() => console.log('harnessd: connected'), (e: Error) => {
  console.error(`harnessd: ${e.message}`);
  process.exit(2);
});

const stop = async () => {
  await daemon.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
