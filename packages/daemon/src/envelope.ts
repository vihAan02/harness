// Renders what an agent reads: every message, notice and task arrives in an envelope that says
// where it came from and how far to trust it (D-25; protocol.md §8). Phrased as facts, never as
// imperative "system" commands (F-10). Injected verbatim (D-63).

export type TaskForAgent = { id: string; title: string; text: string; scope: string[]; ownerHumanId: string };

/** The task a local owner wrote for their own agent: the session's first message. */
export function renderTask(t: TaskForAgent): string {
  return [
    '[harness task]',
    `SOURCE: human/${t.ownerHumanId} (local owner)`,
    'TRUST: owner instruction',
    'PERMISSIONS: none',
    `TASK: ${t.id}   TITLE: ${t.title}`,
    `SCOPE: ${t.scope.length ? t.scope.join(', ') : '(none given)'}`,
    '---',
    t.text,
    '---',
    'The scope says which paths this task is expected to touch. Work only in your worktree.',
  ].join('\n');
}
