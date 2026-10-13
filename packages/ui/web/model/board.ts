// The board's model (D-117): what needs this human, what waits on others, every task with its human, agent, device and
// real state, who's online, and a new-task form. Pure: no DOM, no fetch, no clock (the view passes `now` elsewhere).
// Every string from the snapshot is untrusted; this module only turns it into plain words, never markup.
import type { DerivedTaskState, ProjectSnapshot } from '@harness/protocol';

/** Plain words for a derived task state, e.g. so a colour is never the only signal. */
export function stateWords(state: DerivedTaskState): string {
  switch (state) {
    case 'open': return 'not started';
    case 'awaiting_approval': return 'waiting for its start to be approved';
    case 'starting': return 'starting';
    case 'running': return 'working';
    case 'stopped': return 'stopped: its session ended';
    case 'blocked': return 'blocked by a sync conflict';
    case 'done': return 'its agent is done';
    case 'publish_pending_approval': return 'waiting for you to approve its publish';
    case 'publishing': return 'publishing';
    case 'publish_blocked': return "can't be published";
    case 'pr_open': return 'its PR is open';
    case 'integrating': return "it's integrating";
    case 'outcome_unknown': return 'merge outcome unknown';
    case 'fetch_pending': return "couldn't fetch the base";
    case 'landed': return 'landed';
    case 'abandoned': return 'abandoned';
  }
}

/** The board's columns, in order. `abandoned` is left out: it isn't work anyone is waiting on. */
export const COLUMNS: { key: string; title: string; states: DerivedTaskState[] }[] = [
  { key: 'not_started', title: 'Not started', states: ['open'] },
  { key: 'approval', title: 'Waiting for approval', states: ['awaiting_approval', 'publish_pending_approval'] },
  { key: 'working', title: 'Working', states: ['starting', 'running'] },
  { key: 'needs_human', title: 'Needs a human', states: ['stopped', 'blocked', 'publish_blocked', 'outcome_unknown', 'fetch_pending'] },
  { key: 'review', title: 'In review', states: ['done', 'publishing', 'pr_open', 'integrating'] },
  { key: 'landed', title: 'Landed', states: ['landed'] },
];

export type Card = {
  id: string;
  title: string;
  state: DerivedTaskState;
  words: string;
  detail: string | null;
  owner: string;
  agent: string | null;
  agentHuman: string | null;
  device: string | null;
  deviceOnline: boolean | null;
  costUsd: number;
  mine: boolean;
};

export type BoardModel = {
  columns: { key: string; title: string; cards: Card[] }[];
  devices: { id: string; online: boolean; mine: boolean }[];
  agents: { name: string; human: string; device: string | null; online: boolean | null; taskId: string | null }[];
  budget: { spent: number; daily: number | null; level: 'ok' | 'warn' | 'over' | 'none' };
};

/** The detail line a card shows where the state has a reason (untrusted text from the snapshot). */
function cardDetail(t: ProjectSnapshot['tasks'][number]): string | null {
  return t.state_detail;
}

/** The cards of the board, mine first then by id, laid into their one column. */
export function boardModel(snap: ProjectSnapshot): BoardModel {
  const agentById = new Map(snap.agents.map((a) => [a.id, a]));
  const deviceOnline = new Map(snap.devices.map((d) => [d.device_id, d.online]));

  const stateOf = new Map<string, string>();
  for (const col of COLUMNS) for (const s of col.states) stateOf.set(s, col.key);

  const cards: Card[] = [];
  for (const t of snap.tasks) {
    const agent = t.assignee_agent_id !== null ? agentById.get(t.assignee_agent_id) ?? null : null;
    const agentHuman = agent?.human_id ?? null;
    const device = agent?.device_id ?? t.session?.device_id ?? null;
    const mine = t.owner_human_id === snap.principal || agentHuman === snap.principal;
    cards.push({
      id: t.id,
      title: t.title,
      state: t.state,
      words: stateWords(t.state),
      detail: cardDetail(t),
      owner: t.owner_human_id,
      agent: agent?.name ?? null,
      agentHuman,
      device,
      deviceOnline: device !== null ? deviceOnline.get(device) ?? null : null,
      costUsd: t.cost_usd,
      mine,
    });
  }

  cards.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const columns = COLUMNS.map((col) => ({
    key: col.key,
    title: col.title,
    cards: cards.filter((c) => col.states.includes(c.state)),
  }));

  const devices = snap.devices.map((d) => ({ id: d.device_id, online: d.online, mine: d.device_id === snap.device_id }));
  const agents = snap.agents.map((a) => ({
    name: a.name,
    human: a.human_id,
    device: a.device_id,
    online: a.online,
    taskId: a.active_task_id,
  }));

  const daily = snap.budget.daily_budget_usd;
  const spent = snap.budget.spent_usd;
  let level: BoardModel['budget']['level'];
  if (daily === null) level = 'none';
  else if (daily > 0 && spent >= daily) level = 'over';
  else if (daily > 0 && spent / daily >= 0.8) level = 'warn';
  else level = 'ok';

  return { columns, devices, agents, budget: { spent, daily, level } };
}

const SCOPE_FAIL = 'must be a relative path, with no ".." segment, no "*" except a trailing "/**"';

/** A scope entry goes in as written but must be a safe relative path. */
function validScope(scope: string): boolean {
  if (scope.startsWith('/')) return false;
  const segs = scope.split('/');
  for (const seg of segs) if (seg === '..' || seg === '.') return false;
  if (scope.includes('*')) {
    if (!scope.endsWith('/**')) return false;
    const head = scope.slice(0, -'/**'.length);
    if (head.includes('*') || head === '') return false;
  }
  return true;
}

export type NewTaskInput = { title: string; text: string; scope: string };
export type NewTaskResult =
  | { ok: true; args: { title: string; text: string; scope: string[] } }
  | { ok: false; errors: Record<string, string> };

/** Validate a new-task form. Title 1–200, text 1–8000, scope a list of relative paths. */
export function newTaskModel(input: NewTaskInput): NewTaskResult {
  const errors: Record<string, string> = {};

  const title = input.title.trim();
  if (title.length === 0) errors.title = 'Give the task a title.';
  else if (title.length > 200) errors.title = 'Keep the title to 200 characters or fewer.';

  const text = input.text.trim();
  if (text.length === 0) errors.text = 'Describe what the task is.';
  else if (text.length > 8000) errors.text = 'Keep the description to 8000 characters or fewer.';

  const scope = input.scope
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const bad = scope.find((s) => !validScope(s));
  if (bad !== undefined) errors.scope = `${SCOPE_FAIL}: "${bad}"`;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, args: { title, text, scope } };
}
