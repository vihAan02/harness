// One task's page (D-117): everything about it, and every action its state allows. The view builds DOM only with
// dom.ts and sends only through ctx.api inside an Action. Every string from a snapshot or a message is untrusted: it
// goes into the page as a text node only, long text in a <pre>, and never alone carries meaning that colour would.
//
// The data sections and the action controls are kept apart: the data is rebuilt only when what it shows changed, while
// each action's control (its button, its field, its Action and its typed text) is built once and reused across renders,
// so a re-render every few seconds never wipes a pending send, a label or a selected agent.
import type { ProjectSnapshot } from '@harness/protocol';
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

/** Everything the data sections show. A key over this rebuilds them only when the content changed. */
function dataKey(model: TaskModel): string {
  return JSON.stringify(model);
}

/** The data sections: the header, who, what it's changing, notices and wait, tests and PR, session, task text. */
function dataContainer(model: TaskModel, ctx: ViewContext): HTMLElement {
  return el('div', { class: 'task-data' },
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
  );
}

/** One action's persistent control: the button, the field a needs-input action opens, the hint, the status line, and
 * the Action itself. Built once per kind and reused, so nothing typed or pending is lost when the page re-renders. */
type Control = { node: HTMLElement; action: Action | null; update: () => void };

function actionControl(a: TaskAction, id: string, ctx: ViewContext): Control {
  const status = el('p', { class: 'action-status', role: 'status' });
  const hintLine = el('p', { class: 'action-hint' });
  const body = el('div', { class: 'action-body' });
  const state: { action: Action | null } = { action: null };

  const input = (): HTMLSelectElement | HTMLTextAreaElement | null => body.querySelector('select, textarea');
  const value = (): string => {
    const node = input();
    if (node === null) return '';
    return node instanceof HTMLTextAreaElement ? node.value.trim() : node.value;
  };

  // The start hint: a start on another human's Mac asks them to approve it first. Shown before the click — computed
  // whenever the chosen agent changes (and on first render), and left up while the Action runs.
  const refreshHint = (): void => {
    clear(hintLine);
    if (a.kind !== 'start') return;
    const snap = ctx.snapshot();
    if (snap === null) return;
    const chosen = snap.agents.find((ag) => ag.id === value()) ?? null;
    if (chosen !== null && chosen.human_id !== snap.principal) {
      hintLine.append(`${chosen.human_id}'s Mac will ask them to approve this start`);
    }
  };

  if (a.needs === 'agent') {
    const snap = ctx.snapshot();
    const options = snap === null ? [] : snap.agents;
    const select = el('select', { name: 'agent', 'aria-label': 'Agent' }, ...options.map((ag) => el('option', { value: ag.id }, `${ag.name} (${ag.human_id})`)));
    listen(select, 'change', () => update());
    body.append(el('label', { class: 'action-label' }, 'Agent'), select);
  } else if (a.needs !== null) {
    const ta = el('textarea', { name: a.needs, rows: '3', 'aria-label': a.label });
    body.append(el('label', { class: 'action-label' }, a.optional ? `${a.label} (optional)` : a.label), ta);
  }

  const send = (commandId: string): Promise<unknown> => {
    const snap = ctx.snapshot();
    if (snap === null) return Promise.reject(new Error('no snapshot'));
    const project = snap.project_id;
    const expected = { task_sha256: taskModel(snap, id)?.taskSha256 ?? '' };
    if (a.kind === 'unblock') return ctx.api.command(project, 'task.unblock', { task_id: id }, commandId);
    const text = value();
    const args: Record<string, unknown> = {};
    if (a.needs === 'agent') args.assignee_agent_id = text;
    else if (a.needs === 'text') args.text = text;
    else if (a.needs === 'reason') args.reason = text;
    else if (a.needs === 'summary') args.summary = text;
    return ctx.api.dispatch(project, a.kind, id, args, expected, commandId);
  };

  const button = el('button', { type: 'button', class: `task-action action-${a.kind}` }, `Send: ${a.label}`);
  const update = (): void => {
    // The hint is its own line beside the button: recomputed every render so it shows on first render and tracks the
    // chosen agent, and left in place while the Action runs (a pending start still asks the other human to approve).
    refreshHint();
    clear(status);
    // The Action's own words win once there is one; before that the line is empty.
    if (state.action !== null) status.append(state.action.label());
    button.disabled = ctx.offline() !== null || (state.action !== null && state.action.busy());
  };

  listen(button, 'click', () => {
    if (state.action !== null && state.action.busy()) return;
    const action = new Action(send);
    state.action = action;
    update();
    void action.send().then(update);
  });

  const node = a.needs !== null || a.kind === 'unblock'
    ? el('div', { class: 'action-field' }, el('h3', {}, a.label), body, button, hintLine, status)
    : el('div', { class: 'action-field' }, button, hintLine, status);

  // Expose the per-control update through the closure so the page can re-observe it every render.
  return { node, get action() { return state.action; }, update };
}

/** The page's action controls: one per kind offered, reused across renders so a pending send and typed text survive.
 * Kind → its control. A control whose kind is no longer offered is dropped unless its Action is still pending.
 * `offered` is always what the task allows a signed-in human (built with offline=false): while the bridge is offline
 * each control's update() disables it instead of the control being torn down, so typed text and a pending send stay. */
function actionsSection(id: string, ctx: ViewContext): { node: HTMLElement; sync: (offered: TaskAction[]) => void; controls: Control[] } {
  const container = el('div', { class: 'action-list' });
  const byKind = new Map<string, Control>();
  const sync = (offered: TaskAction[]): void => {
    const want = new Map<string, TaskAction>(offered.map((a) => [a.kind, a]));
    // Drop a control no longer offered, unless its Action is still busy (a pending send keeps its place).
    for (const [kind, control] of byKind) {
      if (!want.has(kind) && !(control.action !== null && control.action.busy())) {
        control.node.remove();
        byKind.delete(kind);
      }
    }
    // Create a control for a kind newly offered; keep any already there.
    for (const a of offered) {
      if (!byKind.has(a.kind)) {
        const control = actionControl(a, id, ctx);
        byKind.set(a.kind, control);
        container.append(control.node);
      }
    }
  };
  return { node: container, sync, get controls() { return [...byKind.values()]; } };
}

export function mount(root: HTMLElement, ctx: ViewContext): () => void {
  const id = ctx.params[0] ?? '';
  const off = ctx.onChange(render);
  // The data is rebuilt only when what it shows changed; the actions section and its controls live outside it, rebuilt
  // only as the offered kinds change, so a re-render every few seconds neither wipes a pending control nor steals focus.
  const data = el('div', { class: 'task-data-wrap' });
  const actions = actionsSection(id, ctx);
  const actionsNote = el('p', { class: 'action-note' });
  const actionsPanel = el('section', { class: 'panel task-actions' }, el('h2', {}, 'Actions'), actionsNote, actions.node);
  let lastKey: string | null = null;
  let controlsShown = false;

  function showMessage(message: string): void {
    clear(root);
    root.append(el('p', { class: 'muted' }, message));
    lastKey = null;
    controlsShown = false;
  }

  function render(): void {
    const snap = ctx.snapshot();
    if (snap === null) { showMessage('Loading…'); return; }
    const model = taskModel(snap, id);
    if (model === null) { showMessage(`No task ${id} in this project.`); return; }
    // The offered controls are always what the task allows, built without the offline flag: a bridge blip must not
    // tear a control down and lose its typed text. update() disables each one while offline() is set.
    const offered = actionsFor(snap, id, false);
    const key = dataKey(model);
    if (key !== lastKey) {
      lastKey = key;
      clear(data);
      data.append(dataContainer(model, ctx));
    }
    actions.sync(offered);
    // One line under the heading: offline (controls wait), nothing offered, or nothing at all.
    clear(actionsNote);
    if (ctx.offline() !== null) actionsNote.append("Offline: actions wait until it's back.");
    else if (offered.length === 0) actionsNote.append('No actions for you on this task.');
    if (root.firstChild !== data || !controlsShown) {
      clear(root);
      root.append(data, actionsPanel);
      controlsShown = true;
    }
    // Re-observe every control against the latest snapshot and refresh its status line and disabled state.
    for (const control of actions.controls) {
      if (control.action !== null && snap !== null) control.action.observe(snap);
      control.update();
    }
  }

  render();
  return () => { off(); clear(root); };
}

export default { mount } satisfies View;
