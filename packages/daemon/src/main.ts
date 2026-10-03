#!/usr/bin/env node
// Runs harnessd in the foreground (D-75): `npm run daemon`. Ctrl-C stops it.
import { loadConfig, type LocalConfig } from './config.ts';
import { Daemon } from './daemon.ts';
import { harnessHome } from './home.ts';
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
const daemon = new Daemon({ home, config, provider, log: (m) => console.log(`harnessd: ${m}`) });
await daemon.start();
console.log(`harnessd: device ${config.deviceId}, ${config.projects.length} project(s), server ${config.serverUrl}`);
console.log(`harnessd: agents run on ${provider.model?.id ?? "the vendor's default model"}${provider.name ? ` via provider "${provider.name}"` : ''}`);
void daemon.ready().then(() => console.log('harnessd: connected'));

const stop = async () => {
  await daemon.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
