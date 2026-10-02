#!/usr/bin/env node
// `harness`, the human CLI (docs/architecture.md §2). Its commands arrive in 0A item 9 (D-54).
import { PROTOCOL_VERSION } from '@harness/protocol';
import pkg from '../package.json' with { type: 'json' };

const [command] = process.argv.slice(2);
if (command === '--version' || command === '-v') {
  console.log(`harness ${pkg.version} (protocol v${PROTOCOL_VERSION})`);
} else {
  console.error('harness: no commands yet (Phase 0A item 9). Try --version.');
  process.exitCode = 1;
}
