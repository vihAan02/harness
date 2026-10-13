// One approval's model (D-117, D-112): everything about it, laid out for reading in full before it can be approved.
// Pure: no DOM, no fetch, no clock. Every string is untrusted; this module only builds plain label/value pairs.
import type { PendingApproval, ProjectSnapshot } from '@harness/protocol';
import { stateWords } from './board.ts';

export type ApprovalModel = {
  id: string;
  kind: string;
  task: string;
  heading: string;
  rows: [string, string][];
  long: [string, string][];
  hash: string;
};

/** The approval's heading, exactly as the board's attention queue says it, so the two read the same. */
function heading(a: PendingApproval, snap: ProjectSnapshot | null): string {
  const title = snap !== null ? snap.tasks.find((t) => t.id === a.task_id)?.title ?? a.task_id : a.task_id;
  switch (a.kind) {
    case 'setup': return `Approve the setup command for ${title}`;
    case 'test': return `Approve the test command for landing ${title}`;
    case 'publish': return `Approve publishing ${title} as a PR`;
    case 'agent_session': {
      const d = a.details;
      if (d !== null) return `${d.issuer_human_id} asks to ${d.kind} ${d.agent_name} on ${title}`;
      return `Another human's request for ${title}`;
    }
    case 'security_review': return `A held message for ${title}: review it`;
  }
}

export function approvalModel(a: PendingApproval, snap: ProjectSnapshot | null = null): ApprovalModel {
  const rows: [string, string][] = [];
  const long: [string, string][] = [];

  switch (a.kind) {
    case 'setup':
    case 'test': {
      rows.push(['Command', a.command]);
      for (const m of a.manifests) rows.push([`Manifest "${m.path}"`, m.sha256 ?? 'missing']);
      if (a.details === null) long.push(['Request', a.command]);
      break;
    }
    case 'publish': {
      const d = a.details;
      if (d === null) {
        long.push(['Request', a.command]);
        break;
      }
      rows.push(['Repository', d.github_repo], ['Branch', d.branch], ['Head', d.head_sha], ['Base', d.base_sha], ['PR title', d.pr_title]);
      for (const h of d.held) rows.push([`Held by "${h.rule}"`, h.path ?? '']);
      long.push(['PR body', d.pr_body], ['Diffstat', d.diffstat]);
      break;
    }
    case 'agent_session': {
      const d = a.details;
      if (d === null) {
        long.push(['Request', a.command]);
        break;
      }
      rows.push(
        ['Asked by', `${d.issuer_human_id} on ${d.issuer_device_id}`],
        ['Kind', d.kind],
        ['Agent', d.agent_name],
        ['Task', `${d.task_id}: ${d.task_title}`],
        ['Scope', d.task_scope.join(', ')],
        ['Task owner', d.task_owner_human_id],
        ['Expires', d.expires_at],
      );
      long.push(['Task text', d.task_text]);
      if (d.message !== null) long.push(['Message', d.message]);
      break;
    }
    case 'security_review': {
      const d = a.details;
      if (d === null) {
        long.push(['Request', a.command]);
        break;
      }
      rows.push(['About', d.about], ['From', d.from], ['Rules', d.rules.join(', ')]);
      long.push(['Held text', d.text]);
      break;
    }
  }

  const task = snap !== null ? snap.tasks.find((t) => t.id === a.task_id) : undefined;
  return {
    id: a.id,
    kind: a.kind,
    task: task !== undefined ? `${task.id}: ${task.title} — ${stateWords(task.state)}` : a.task_id,
    heading: heading(a, snap),
    rows,
    long,
    hash: a.hash,
  };
}
