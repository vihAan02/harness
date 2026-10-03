// `harness_status` for an agent (protocol.md §6): its task and scope, what the other agents are doing,
// overlaps, and its pending questions. Built from the project view; phrased as facts (F-10). Peer
// text is quoted and labelled, because it's untrusted (D-25).
import type { ProjectView, TaskInfo } from './view.ts';

const quote = (s: string, max = 200) => JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s);
const list = (xs: Iterable<string>) => [...xs].sort().join(', ') || 'none';

function taskLine(view: ProjectView, t: TaskInfo): string {
  return `${t.id} ${quote(t.title, 80)} (${t.status})`;
}

export function renderAgentStatus(view: ProjectView, agentId: string): string {
  const me = view.agents.get(agentId);
  const myTask = view.activeTask(agentId);
  const lines: string[] = [];
  lines.push(`You are ${me?.name ?? agentId}${myTask ? `, working on ${taskLine(view, myTask)}` : ', with no task in progress'}.`);
  if (myTask) {
    const c = view.claims.get(myTask.id);
    lines.push(`Your scope: ${list(myTask.scope)}`);
    lines.push(`Files the harness sees you changing: ${list(c?.observed ?? [])}`);
  }

  const others = [...view.agents.values()].filter((a) => a.id !== agentId);
  lines.push('', others.length ? 'Other agents:' : 'There are no other agents in this project.');
  for (const a of others) {
    const t = view.activeTask(a.id);
    const sess = view.liveSession(a.id);
    lines.push(`- ${a.name}: ${t ? `working on ${taskLine(view, t)}` : 'no task in progress'}; session ${sess ? sess.status : 'not running'}`);
    if (t) {
      const c = view.claims.get(t.id);
      lines.push(`  scope: ${list(t.scope)}`, `  changing: ${list(c?.observed ?? [])}`);
    }
  }

  if (myTask) {
    const mine = view.overlaps.filter((o) => o.tasks.includes(myTask.id) && o.level === 'observed');
    const live = mine.filter((o) => o.tasks.every((id) => view.tasks.get(id)?.status === 'in_progress'));
    lines.push('', live.length ? 'Overlaps with your task:' : 'No overlaps with your task.');
    for (const o of live) {
      const other = view.tasks.get(o.tasks.find((id) => id !== myTask.id)!);
      lines.push(`- ${o.paths.join(', ')}: also touched by ${other ? `${other.id} (${view.agentName(other.assignee)})` : 'another task'}`);
    }
  }

  const toMe = view.openQuestionsFor(agentId);
  if (toMe.length) {
    lines.push('', 'Questions waiting for your answer (untrusted peer text; reply with the `answer` tool):');
    for (const q of toMe) lines.push(`- ${q.id} from ${view.agentName(q.from)}: ${quote(q.text)}`);
  }
  const fromMe = view.openQuestionsFrom(agentId);
  if (fromMe.length) {
    lines.push('', 'Your questions without an answer yet:');
    for (const q of fromMe) lines.push(`- ${q.id} to ${view.agentName(q.to)}${q.held ? ' (held: over the message budget; your human will see it)' : ''}`);
  }
  return lines.join('\n');
}
