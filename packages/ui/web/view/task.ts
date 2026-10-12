// One task's page (D-117): everything about it, and every action its state allows. The view builds DOM only with
// dom.ts and sends only through ctx.api inside an Action. Every string from a snapshot or a message is untrusted: it
// goes into the page as a text node only, long text in a <pre>, and never alone carries meaning that colour would.
import { Action } from '../action.ts';
import type { ViewContext, View } from '../app.ts';
import { clear, el, listen } from '../dom.ts';
import { actionsFor, taskModel } from '../model/task.ts';
import type { TaskAction, TaskModel } from '../model/task.ts';

const EMPTY = 'None yet';

function dollars(n: number): string {
  return `$${n.toFixed(3)}`;
}

/** A list of strings, or one line saying there is nothing yet. */
function list(items: string[], empty: string): HTMLElement {
  if (items.length === 0) return el('p', { class: 'muted' }, empty);
  return el('ul', { class: 'task-list' }, ...items.map((s) => el('li', {}, s)));
}

/** The tests and PR panel, with a button to the integration page when the task has a PR. */
function prSection(model: TaskModel, ctx: ViewContext): HTMLElement {
  const pr = model.pr;
  const body: (Node | string | null)[] = [
    pr === null ? el('p', { class: 'muted' }, EMPTY) : el('p', {}, `#${pr.number} · ${pr.state}${pr.merged ? ' · merged' : ''} · head ${pr.head}`),
  ];
  if (pr !== null) {
    const button = el('button', { type: 'button', class: 'to-integration' }, 'Open integration');
    listen(button, 'click', () => ctx.navigate('#/integration'));
    body.push(button);
  }
  body.push(el('h3', {}, 'Tests'), list(model.tests, EMPTY));
  return el('section', { class: 'panel' }, el('h2', {}, 'Tests and PR'), ...body);
}

/** One action's control: the button, and the field a needs-input action opens, with a Send. The Action lives in the
 * control, so a re-render (the view re-renders on every change) never loses a pending send or typed text. */
function actionControl(a: TaskAction, model: TaskModel, ctx: ViewContext): HTMLElement {
  const status = el('p', { class: 'action-status', role: 'status' });
  const body = el('div', { class: 'action-body' });
  const state: { action: Action | null; hint: string | null } = { action: null, hint: null };

  const value = (): string => {
    const input = body.querySelector('select, textarea');
    if (input === null) return '';
    return input instanceof HTMLTextAreaElement ? input.value.trim() : (input as HTMLSelectElement).value;
  };

  if (a.needs === 'agent') {
    const snap = ctx.snapshot();
    const options = snap === null ? [] : snap.agents;
    const select = el('select', { name: 'agent', 'aria-label': 'Agent' }, ...options.map((ag) => el('option', { value: ag.id }, `${ag.name} (${ag.human_id})`)));
    body.append(el('label', { class: 'action-label' }, 'Agent'), select);
  } else if (a.needs !== null) {
    const ta = el('textarea', { name: a.needs, rows: '3', 'aria-label': a.label });
    body.append(el('label', { class: 'action-label' }, a.optional ? `${a.label} (optional)` : a.label), ta);
  }

  const send = (commandId: string): Promise<unknown> => {
    const snap = ctx.snapshot();
    if (snap === null) return Promise.reject(new Error('no snapshot'));
    const project = snap.project_id;
    const expected = { task_sha256: model.taskSha256 };
    if (a.kind === 'unblock') return ctx.api.command(project, 'task.unblock', { task_id: model.id }, commandId);
    const text = value();
    const args: Record<string, unknown> = {};
    if (a.needs === 'agent') args.assignee_agent_id = text;
    else if (a.needs === 'text') args.text = text;
    else if (a.needs === 'reason') args.reason = text;
    else if (a.needs === 'summary') args.summary = text;
    return ctx.api.dispatch(project, a.kind, model.id, args, expected, commandId);
  };

  const button = el('button', { type: 'button', class: `task-action action-${a.kind}` }, `Send: ${a.label}`);
  const update = (): void => {
    clear(status);
    // The Action's own words win; before there is one, the start hint (if any) is what the line shows.
    if (state.action !== null) status.append(state.action.label());
    else if (state.hint !== null) status.append(state.hint);
    button.disabled = ctx.offline() !== null || (state.action !== null && state.action.busy());
  };

  listen(button, 'click', () => {
    if (state.action !== null && state.action.busy()) return;
    state.hint = null;
    // A start on another human's Mac will ask them to approve it first; say so before the click lands.
    if (a.kind === 'start') {
      const chosen = ctx.snapshot()?.agents.find((ag) => ag.id === value()) ?? null;
      if (chosen !== null && chosen.human_id !== (ctx.snapshot()?.principal ?? null)) {
        state.hint = `${chosen.human_id}'s Mac will ask them to approve this start`;
      }
    }
    const action = new Action(send);
    state.action = action;
    update();
    void action.send().then(update);
  });

  if (a.needs !== null || a.kind === 'unblock') {
    return el('div', { class: 'action-field' }, el('h3', {}, a.label), body, button, status);
  }
  return el('div', { class: 'action-field' }, button, status);
}

export function mount(root: HTMLElement, ctx: ViewContext): () => void {
  const id = ctx.params[0] ?? '';
  const off = ctx.onChange(render);
  // The data and the action controls are rebuilt together, and only when what they show changed, so a re-render
  // every few seconds neither rebuilds a pending control nor steals focus.
  const data = el('div', { class: 'task-data' });
  let lastKey: string | null = null;

  function render(): void {
    const snap = ctx.snapshot();
    if (snap === null) {
      clear(root);
      root.append(el('p', { class: 'muted' }, 'Loading…'));
      lastKey = null;
      return;
    }
    const model = taskModel(snap, id);
    if (model === null) {
      clear(root);
      root.append(el('h2', {}, `No task ${id} in this project.`));
      lastKey = null;
      return;
    }
    const actions = actionsFor(snap, id, ctx.offline() !== null);
    const key = JSON.stringify({ model, actions });
    if (key !== lastKey) {
      lastKey = key;
      clear(data);
      data.append(
        el('section', { class: 'panel task-header' },
          el('h2', {}, `${model.id}: ${model.title}`),
          el('p', { class: 'task-words' }, model.words),
          model.detail !== null ? el('p', { class: 'muted' }, model.detail) : null,
        ),
        el('section', { class: 'panel' },
          el('h2', {}, 'Who'),
          el('p', {}, `owner ${model.owner}`),
          model.agent !== null
            ? el('p', {}, `agent ${model.agent.name} (${model.agent.human}) · ${model.agent.device ?? 'no device yet'} ${model.agent.online === true ? 'online' : model.agent.online === false ? 'offline' : ''}`)
            : el('p', { class: 'muted' }, 'No agent assigned'),
        ),
        el('section', { class: 'panel' },
          el('h2', {}, "What it's changing"),
          el('h3', {}, 'Changing'),
          list(model.changing, EMPTY),
          el('h3', {}, 'Overlaps'),
          list(model.overlaps, EMPTY),
          el('h3', {}, 'Stale reads'),
          list(model.stale, EMPTY),
        ),
        el('section', { class: 'panel' },
          el('h2', {}, 'Notices'),
          model.notices.length === 0
            ? el('p', { class: 'muted' }, EMPTY)
            : el('div', {}, ...model.notices.map((n) => el('div', { class: 'notice' },
              el('p', { class: 'notice-meta' }, `${n.from} → ${n.kind} · ${n.sentAt} · ${n.delivery}`),
              el('pre', { class: 'notice-text' }, n.text),
            ))),
          model.wait !== null ? el('p', { class: 'task-wait' }, model.wait) : null,
        ),
        prSection(model, ctx),
        el('section', { class: 'panel' },
          el('h2', {}, 'Session and cost'),
          el('p', {}, `${dollars(model.costUsd)} in total`),
          model.session === null
            ? el('p', { class: 'muted' }, 'No session yet')
            : el('p', {}, `${model.session.status}${model.session.model !== null ? ` · ${model.session.model}` : ''}${model.session.endReason !== null ? ` · ended: ${model.session.endReason}` : ''} · ${dollars(model.session.costUsd)} · ${model.session.input} in, ${model.session.output} out`),
        ),
        el('section', { class: 'panel' },
          el('h2', {}, 'Task text'),
          el('pre', { class: 'task-text' }, model.text),
          el('h3', {}, 'Scope'),
          list(model.scope, EMPTY),
        ),
        el('section', { class: 'panel task-actions' },
          el('h2', {}, 'Actions'),
          ...(actions.length === 0
            ? [el('p', { class: 'muted' }, ctx.offline() !== null ? "Offline: actions wait until it's back." : 'No actions for you on this task.')]
            : actions.map((a) => actionControl(a, model, ctx))),
        ),
      );
    }
    if (root.firstChild !== data) { clear(root); root.append(data); }
  }

  render();
  return () => { off(); clear(root); };
}

export default { mount } satisfies View;
