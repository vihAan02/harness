#!/usr/bin/env node
// Runs harnessd in the foreground (D-75): `npm run daemon`. Ctrl-C stops it.
import { loadConfig, type LocalConfig } from './config.ts';
import { Daemon } from './daemon.ts';
import { harnessHome } from './home.ts';

const home = harnessHome();
let config: LocalConfig;
try {
  config = loadConfig(home);
} catch (e) {
  console.error(`harnessd: ${(e as Error).message}`);
  process.exit(2);
}
const daemon = new Daemon({ home, config, log: (m) => console.log(`harnessd: ${m}`) });
await daemon.start();
console.log(`harnessd: device ${config.deviceId}, ${config.projects.length} project(s), server ${config.serverUrl}`);
void daemon.ready().then(() => console.log('harnessd: connected'));

const stop = async () => {
  await daemon.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
