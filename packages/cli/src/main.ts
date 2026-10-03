#!/usr/bin/env node
// `harness`, the human CLI (docs/architecture.md §2). The task and agent commands arrive in 0A item 9 (D-54).
import { createInterface } from 'node:readline/promises';
import { Approvals, harnessHome, type ApprovalRequest } from '@harness/daemon';
import { PROTOCOL_VERSION } from '@harness/protocol';
import pkg from '../package.json' with { type: 'json' };

const USAGE = `usage:
  harness --version
  harness approve               list setup commands waiting for your approval
  harness approve <id> [--yes]  review one and approve it`;

const [command, ...rest] = process.argv.slice(2);
if (command === '--version' || command === '-v') {
  console.log(`harness ${pkg.version} (protocol v${PROTOCOL_VERSION})`);
} else if (command === 'approve') {
  await approve(rest);
} else {
  console.error(USAGE);
  process.exitCode = 1;
}

/** D-52: the local human approves a repo's setup command (and its manifests) before harnessd runs it. */
async function approve(args: string[]) {
  const approvals = new Approvals(harnessHome());
  const id = args.find((a) => !a.startsWith('-'));
  const pending = approvals.pending();
  if (!id) {
    if (pending.length === 0) return console.log('No setup commands are waiting for approval.');
    for (const r of pending) describe(r);
    return console.log('Approve one with: harness approve <id>');
  }
  const matches = pending.filter((r) => r.id.startsWith(id));
  if (matches.length !== 1) {
    console.error(matches.length ? `${id} matches more than one request; use more of the id.` : `No pending approval ${id}.`);
    process.exitCode = 1;
    return;
  }
  const req = matches[0]!;
  describe(req);
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) {
      console.error('Not a terminal: pass --yes to approve without a prompt.');
      process.exitCode = 1;
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Approve this command? [y/N] ');
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return console.log('Not approved.');
  }
  approvals.approve(req.id);
  console.log(`Approved ${req.id}. harnessd will run it in the sandbox: writes only in the worktree, no secrets, network limited to your allowlist.`);
}

function describe(r: ApprovalRequest) {
  console.log(`\n${r.id}  project ${r.projectId}, first requested for task ${r.taskId}`);
  console.log(`  command:   ${r.command}`);
  for (const m of r.manifests) console.log(`  manifest:  ${m.path}  ${m.sha256 ? m.sha256.slice(0, 12) : '(absent)'}`);
  console.log('  This command comes from the repo, so anyone who can commit can change it. Approving covers exactly this text and these manifests.\n');
}
