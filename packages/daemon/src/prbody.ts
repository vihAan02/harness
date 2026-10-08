// A Harness task's PR text (D-114): every section of the repo's PR template (.github/pull_request_template.md), filled
// from what harnessd knows, so the squash commit is the same kind of handoff record as a human's PR (AGENTS.md).
// Everything here is harnessd's own wording around facts; the agent's summary is quoted as the agent's.

export type PrFacts = {
  taskId: string; title: string; summary: string | null; scope: string[];
  agent: { id: string; name: string }; human: { id: string; login: string | null };
  changed: string[]; diffStat: string;
  /** Usage across the task's sessions. */
  cost: { usd: number; sessions: number; models: string[]; provider: string | null };
  /** Reviewers AGENTS.md requires, from CODEOWNERS at the base (codeowners.ts). */
  reviewers: string[];
  closes: number | null;
};

const CONTRACT = /^(packages\/protocol\/|docs\/protocol\.md$)/;
const MIGRATION = /^packages\/server\/migrations\//;
const DECISIONS = /^(PLAN\.md|docs\/research\/vendor-capabilities\.md)$/;

/** Paths outside the task's declared scope (prefixes ending in "/" and exact files, D-21). */
export function outOfScope(scope: string[], paths: string[]): string[] {
  if (!scope.length) return [];
  return paths.filter((p) => !scope.some((s) => (s.endsWith('/') ? p.startsWith(s) : p === s)));
}

export function prTitle(f: Pick<PrFacts, 'taskId' | 'title'>): string {
  return `${f.taskId}: ${f.title}`.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 250);
}

export function prBody(f: PrFacts): string {
  const outside = outOfScope(f.scope, f.changed);
  const list = (paths: string[]) => paths.slice(0, 50).map((p) => `- \`${p.replace(/`/g, "'")}\``).join('\n') + (paths.length > 50 ? `\n- … and ${paths.length - 50} more` : '');
  const contracts = f.changed.filter((p) => CONTRACT.test(p));
  const migrations = f.changed.filter((p) => MIGRATION.test(p));
  const decisions = f.changed.filter((p) => DECISIONS.test(p));
  const quote = (t: string) => t.trim().split('\n').map((l) => `> ${l}`).join('\n');
  return [
    `**Task:** ${f.taskId} (a Harness task)${f.closes ? `. Closes #${f.closes}` : ''}`,
    '',
    '## What changed, and why',
    `${f.title}. Written by Harness agent \`${f.agent.name}\`, accountable to ${f.human.login ? `@${f.human.login}` : f.human.id}. The agent's summary:`,
    f.summary?.trim() ? quote(f.summary) : '> (none given)',
    '',
    '## Files touched',
    list(f.changed) || 'none',
    ...(outside.length ? ['', `**Outside the task's scope (${f.scope.join(', ')}):**`, list(outside)] : []),
    '',
    '```', f.diffStat.trim() || '(no changes)', '```',
    '',
    '## Contract changes',
    contracts.length ? `Touches contract files; see the diff:\n${list(contracts)}` : 'none',
    '',
    '## D-IDs and F-IDs',
    decisions.length ? `Touches the registers; see the diff:\n${list(decisions)}` : 'none',
    '',
    '## Migrations',
    migrations.length ? list(migrations) : 'none',
    '',
    '## New config or environment variables',
    'none known to harnessd; see the diff',
    '',
    '## Tests run',
    'None by harnessd before publishing. The required checks (`guard`, `unit-linux`, `full-macos`) run on this PR, and the human approves the exact head before harnessd merges it (D-115).',
    '',
    '## Real-model cost',
    f.cost.sessions
      ? `$${f.cost.usd.toFixed(4)} over ${f.cost.sessions} session(s)${f.cost.provider ? `, provider ${f.cost.provider}` : ''}${f.cost.models.length ? `, ${f.cost.models.join(', ')}` : ''}.`
      : 'none recorded',
    '',
    '## Review',
    f.reviewers.length ? `- [ ] Not needed: own files only, no contract change\n- [x] Needed from: ${f.reviewers.map((r) => `@${r}`).join(' ')} (CODEOWNERS at the base)` : '- [x] Not needed: own files only, no contract change\n- [ ] Needed from:',
    '',
    '## Notes for the other stream',
    `Opened by harnessd for task ${f.taskId}. Comment here; the task's human reopens it if it needs changes.`,
    '',
    '## Follow-ups',
    'none',
  ].join('\n');
}
