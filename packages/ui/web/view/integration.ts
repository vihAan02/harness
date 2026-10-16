// The integration page (D-114, D-115, D-116): every task's PR, its checks and reviews, the one integration in flight,
// merges made outside the harness, security alerts, and this Mac's spend and provider state. The view builds DOM only
// with dom.ts and sends only through ctx.api inside an Action. Every string from a snapshot is untrusted: it goes into
// the page as a text node only. The only links are prUrl's own https://github.com/… links; a PR without one shows as
// text. Colour is never the only signal: every coloured class has words beside it.
//
// The data sections are rebuilt only when their content changed. Each row's Integrate control (its button, its confirm
// panel, its Action and its status line) is built once and kept in a Map by task, so a re-render every few seconds
// neither closes an open confirm panel nor wipes a pending send. Integrate sends the `expected` captured when its
// confirm panel was rendered, never one re-read at click time.
import type { ProjectSnapshot } from '@harness/protocol';
import { Action } from '../action.ts';
import type { ViewContext, View } from '../app.ts';
import { clear, el, listen } from '../dom.ts';
import { REQUIRED, budgetModel, integrationModel, prUrl } from '../model/integration.ts';
import type { IntegrationModel, IntegrationRow } from '../model/integration.ts';
import { formatUsd } from '../model/format.ts';

const NONE = 'None';
const CONFLICT = "The PR's head or base changed since you looked; review the new head.";
const PANEL_CONFLICT = 'The PR\'s head or base changed since you opened this; cancel and look again.';

/** The in-flight land, or nothing. It comes first: one integration at a time. */
function inFlightSection(model: IntegrationModel): HTMLElement {
  if (model.inFlight === null) return el('section', { class: 'panel in-flight' }, el('h2', {}, 'Integrating now'), el('p', { class: 'muted' }, NONE));
  return el('section', { class: 'panel in-flight' },
    el('h2', {}, 'Integrating now'),
    el('p', { class: 'in-flight-words' }, model.inFlight.words),
    el('p', { class: 'muted in-flight-since' }, `since ${model.inFlight.since}`),
  );
}

/** A PR checks list: each check's plain words, the required ones first (ordered by the model). */
function checksCell(row: IntegrationRow): Node {
  if (row.checks.length === 0) return el('span', { class: 'muted' }, 'no checks');
  return el('ul', { class: 'checks' }, ...row.checks.map((c) =>
    el('li', { class: `check check-${c.conclusion === 'success' ? 'pass' : c.conclusion === 'failure' ? 'fail' : 'other'}` },
      el('span', { class: 'check-name' }, c.name),
      el('span', { class: 'check-words' }, c.words),
    )));
}

/** The reviews, each with its login, state and whether it is on the current head. */
function reviewsCell(row: IntegrationRow): Node {
  if (row.reviews.length === 0) return el('span', { class: 'muted' }, 'no reviews');
  return el('ul', { class: 'reviews' }, ...row.reviews.map((r) =>
    el('li', { class: 'review' },
      el('span', { class: 'review-login' }, r.login),
      el('span', { class: 'review-state' }, r.state),
      el('span', { class: 'muted review-current' }, r.current ? 'on the current head' : 'on an older head'),
    )));
}

/** The PR cell: a checked GitHub link when there is one, else the number as plain text and its state. */
function prCell(row: IntegrationRow): Node {
  if (row.pr === null) return el('span', { class: 'muted' }, 'no PR');
  const body: (Node | string)[] = [];
  if (row.pr.url !== null) {
    body.push(el('a', { class: 'pr-link', href: row.pr.url, rel: 'noreferrer noopener', target: '_blank' }, `#${row.pr.number}`));
  } else {
    body.push(el('span', { class: 'pr-number' }, `#${row.pr.number}`));
  }
  body.push(el('span', { class: 'pr-state' }, `${row.pr.state}${row.pr.merged ? ', merged' : ''}${row.pr.mergeable !== null ? `, ${row.pr.mergeable}` : ''}`));
  return el('span', { class: 'pr-cell' }, ...body);
}

/**
 * One task's Integrate control (D-115): a button that opens a confirm panel naming the exact head and base and every
 * check; the panel's "Integrate this exact head" is the Action. Built once per task and reused: the panel keeps its
 * open state and the Action captured `expected` across re-renders. Not allowed: the button is disabled with the reason
 * beside it.
 */
type Control = { node: HTMLElement; action: Action | null; update: (row?: IntegrationRow) => void };

function integrateControl(task: string, ctx: ViewContext): Control {
  const status = el('p', { class: 'action-status', role: 'status' });
  const openButton = el('button', { type: 'button', class: 'integrate-open' }, 'Integrate…');
  const panel = el('div', { class: 'integrate-panel', hidden: true });
  // The expected captured when the panel was rendered: Integrate sends this, never a value re-read at click time.
  const state: { action: Action | null; expected: { pr_number: number; head_sha: string; base_sha: string } | null } = { action: null, expected: null };

  const body = el('div', { class: 'integrate-body' });
  const sendButton = el('button', { type: 'button', class: 'integrate-send' }, 'Integrate this exact head');
  const cancelButton = el('button', { type: 'button', class: 'integrate-cancel' }, 'Cancel');
  panel.append(body, sendButton, cancelButton, status);

  const close = (): void => {
    panel.hidden = true;
    state.expected = null;
    state.action = null;
    clear(body);
    refresh();
  };
  listen(cancelButton, 'click', close);

  /** Whether the row's current expected still matches the one captured when the panel opened. */
  const expectedChanged = (row: IntegrationRow): boolean => {
    const e = state.expected;
    const now = row.expected;
    if (e === null || now === null) return true;
    return e.pr_number !== now.pr_number || e.head_sha !== now.head_sha || e.base_sha !== now.base_sha;
  };

  /** Re-render the panel from `row`: the captured head and base, every current check, and the change notice. */
  const renderPanel = (row: IntegrationRow): void => {
    if (state.expected === null) return;
    clear(body);
    const e = state.expected;
    body.append(
      el('p', { class: 'integrate-exact' }, `PR #${e.pr_number}`),
      el('p', { class: 'integrate-sha' }, `head ${e.head_sha}`),
      el('p', { class: 'integrate-sha' }, `base ${e.base_sha}`),
      el('h4', {}, 'Checks'),
      checksCell(row),
    );
    if (expectedChanged(row)) body.append(el('p', { class: 'integrate-changed' }, PANEL_CONFLICT));
  };

  let lastRow: IntegrationRow | null = null;

  /** Repaint the button, the status line and (when open) the panel from the last row the page gave us. */
  const refresh = (): void => {
    const row = lastRow;
    if (row === null) return;
    const offline = ctx.offline() !== null;
    const why = row.integrate.why;
    openButton.disabled = offline || !row.integrate.allowed;
    clear(status);
    // The reason not to integrate sits beside the button, its own line.
    if (state.action !== null && state.action.status !== 'idle') status.append(state.action.label());
    else if (why !== null) status.append(why);
    if (state.action !== null && state.action.status === 'conflict') { clear(status); status.append(CONFLICT); }
    sendButton.disabled = offline || expectedChanged(row) || (state.action !== null && state.action.busy());
    cancelButton.disabled = state.action !== null && state.action.busy();
    if (panel.hidden === false) renderPanel(row);
  };

  listen(openButton, 'click', () => {
    if (lastRow === null || lastRow.expected === null) return;
    // Capture the exact head and base the human is about to approve, and open the panel.
    state.expected = lastRow.expected;
    state.action = null;
    panel.hidden = false;
    refresh();
  });

  listen(sendButton, 'click', () => {
    if (state.action !== null && state.action.busy()) return;
    const snap = ctx.snapshot();
    const expected = state.expected;
    if (snap === null || expected === null) return;
    const project = snap.project_id;
    const action = new Action((commandId) => ctx.api.dispatch(project, 'integrate', task, {}, expected, commandId));
    state.action = action;
    refresh();
    void action.send().then(refresh);
  });

  const node = el('div', { class: 'integrate-control' }, openButton, status, panel);
  return {
    node,
    get action() { return state.action; },
    update: (row?: IntegrationRow): void => { if (row !== undefined) lastRow = row; refresh(); },
  };
}

/** A table of every task with a PR or a land: the task, its PR, state, checks, reviews and land. */
function rowsTable(model: IntegrationModel, controls: Map<string, Control>, ctx: ViewContext): HTMLElement {
  return el('table', { class: 'integration-table' },
    el('thead', {},
      el('tr', {},
        el('th', {}, 'Task'),
        el('th', {}, 'PR'),
        el('th', {}, 'State'),
        el('th', {}, 'Checks'),
        el('th', {}, 'Reviews'),
        el('th', {}, 'Land'),
        el('th', {}, 'Integrate'),
      )),
    el('tbody', {}, ...model.rows.map((row) => {
      const control = controls.get(row.task);
      const taskButton = el('button', { type: 'button', class: 'task-link' }, row.task);
      listen(taskButton, 'click', () => ctx.navigate(`#/task/${row.task}`));
      return el('tr', { class: `row row-${row.task}` },
        el('td', { class: 'cell-task' }, taskButton, el('span', { class: 'task-title' }, row.title)),
        el('td', { class: 'cell-pr' }, prCell(row)),
        el('td', { class: 'cell-state' }, row.words),
        el('td', { class: 'cell-checks' }, checksCell(row)),
        el('td', { class: 'cell-reviews' }, reviewsCell(row)),
        el('td', { class: 'cell-land' }, row.land ?? el('span', { class: 'muted' }, NONE)),
        el('td', { class: 'cell-integrate' }, control?.node ?? null),
      );
    })),
  );
}

/** The two lists: merges outside the harness and the security alerts. */
function outsideSection(model: IntegrationModel): HTMLElement {
  return el('section', { class: 'panel outside' },
    el('h2', {}, 'Merges outside the harness'),
    ...(model.outside.length === 0 ? [el('p', { class: 'muted' }, NONE)] : model.outside.map((b) =>
      el('div', { class: 'outside-item' },
        el('p', { class: 'outside-range' }, b.range),
        el('p', { class: 'muted outside-at' }, b.at),
        b.paths.length === 0 ? null : el('p', { class: 'outside-paths' }, b.paths.join(', ')),
      ))),
  );
}

function alertsSection(model: IntegrationModel): HTMLElement {
  return el('section', { class: 'panel alerts' },
    el('h2', {}, 'Security alerts'),
    ...(model.alerts.length === 0 ? [el('p', { class: 'muted' }, NONE)] : model.alerts.map((a) =>
      el('div', { class: 'alert' },
        el('p', { class: 'alert-what' }, `${a.what}${a.task !== null ? ` · ${a.task}` : ''}`),
        el('p', { class: 'muted alert-at' }, a.at),
        a.detail !== null ? el('pre', { class: 'alert-detail' }, a.detail) : null,
      ))),
  );
}

/**
 * Spend and provider (D-116): the day's words, a <progress> whose value is also written as text, the session cap, each
 * task's cost, and an open circuit with its reset. The reset is an Action, built once and reused.
 */
function spendSection(snap: ProjectSnapshot, reset: Control): HTMLElement {
  const model = budgetModel(snap);
  const day = snap.budget.daily_budget_usd;
  const progress = day === null
    ? el('p', { class: 'muted' }, 'No daily budget set')
    : el('div', { class: 'spend-progress' },
      el('progress', { value: String(model.spent), max: String(day) }),
      el('span', { class: 'spend-progress-text' }, `${formatUsd(model.spent)} of ${formatUsd(day)} USD`),
    );
  const cap = model.cap === null
    ? el('p', { class: 'muted' }, 'No session cap set')
    : el('p', { class: 'spend-cap' }, `One session is capped at ${formatUsd(model.cap)}`);
  return el('section', { class: `panel spend level-${model.level}` },
    el('h2', {}, 'Spend and provider'),
    ...model.words.map((w) => el('p', { class: `spend-words level-${model.level}` }, w)),
    progress,
    cap,
    el('h3', {}, 'Cost by task'),
    model.tasks.length === 0
      ? el('p', { class: 'muted' }, NONE)
      : el('ul', { class: 'cost-list' }, ...model.tasks.map((t) =>
        el('li', { class: 'cost-item' },
          el('span', { class: 'cost-task' }, t.task),
          el('span', { class: 'cost-amount' }, t.reported ? formatUsd(t.costUsd) : 'not reported yet'),
        ))),
    model.circuit === null ? null : el('div', { class: 'circuit' },
      el('p', { class: 'circuit-words' }, `${model.circuit.kind}: ${model.circuit.reason}`),
      el('p', { class: 'muted circuit-at' }, model.circuit.at),
      model.circuit.resettable
        ? el('div', { class: 'circuit-reset' }, el('p', { class: 'muted' }, "Reset after you've fixed the account"), reset.node)
        : el('p', { class: 'muted' }, 'This closes on the next UTC day.'),
    ),
  );
}

export function mount(root: HTMLElement, ctx: ViewContext): () => void {
  const data = el('div', { class: 'integration-data' });
  const spentWrap = el('div', { class: 'spend-wrap' });
  const off = ctx.onChange(render);

  // Controls built once and kept by key across renders: one Integrate control per task, and one provider-reset Action.
  const controls = new Map<string, Control>();
  const resetStatus = el('p', { class: 'action-status', role: 'status' });
  const resetButton = el('button', { type: 'button', class: 'provider-reset' }, 'Reset provider circuit');
  const resetState: { action: Action | null } = { action: null };
  const resetControl: Control = {
    node: el('span', { class: 'reset-control' }, resetButton, resetStatus),
    get action() { return resetState.action; },
    update: (): void => {
      clear(resetStatus);
      if (resetState.action !== null) resetStatus.append(resetState.action.label());
      resetButton.disabled = ctx.offline() !== null || (resetState.action !== null && resetState.action.busy());
    },
  };
  listen(resetButton, 'click', () => {
    if (resetState.action !== null && resetState.action.busy()) return;
    const action = new Action(() => ctx.api.providerReset());
    resetState.action = action;
    resetControl.update();
    void action.send().then(() => resetControl.update());
  });

  let lastKey: string | null = null;
  let lastSpendKey: string | null = null;

  function controlFor(task: string): Control {
    let c = controls.get(task);
    if (c === undefined) {
      c = integrateControl(task, ctx);
      controls.set(task, c);
    }
    return c;
  }

  function render(): void {
    const snap = ctx.snapshot();
    if (snap === null) {
      clear(root);
      root.append(el('p', { class: 'muted' }, 'Loading…'));
      lastKey = null;
      return;
    }
    const offline = ctx.offline() !== null;
    const model = integrationModel(snap, offline);
    // The controls are created outside the data (they persist); make sure one exists per row before the table uses it.
    for (const row of model.rows) controlFor(row.task);
    // Drop a control whose task no longer has a row, unless its Action is still busy (a pending send keeps its place).
    const live = new Set(model.rows.map((r) => r.task));
    for (const [task, c] of controls) {
      if (!live.has(task) && !(c.action !== null && c.action.busy())) controls.delete(task);
    }
    const key = JSON.stringify(model);
    if (key !== lastKey) {
      lastKey = key;
      clear(data);
      data.append(
        inFlightSection(model),
        el('section', { class: 'panel rows-panel' },
          el('h2', {}, 'Pull requests'),
          model.rows.length === 0 ? el('p', { class: 'muted' }, NONE) : rowsTable(model, controls, ctx),
          model.mode === 'local' ? el('p', { class: 'muted local-note' }, 'This project lands locally: run harness land <task> on its device.') : null,
        ),
        outsideSection(model),
        alertsSection(model),
      );
    }
    // Rebuild the spend panel only when its own model changed: a rebuild would move the Reset button out of the page
    // and drop its focus, so the panel (and with it the button's place) is kept across renders while it is unchanged.
    const spendKey = JSON.stringify(budgetModel(snap));
    if (spendKey !== lastSpendKey) {
      lastSpendKey = spendKey;
      clear(spentWrap);
      spentWrap.append(spendSection(snap, resetControl));
    }
    if (root.firstChild !== data) {
      clear(root);
      root.append(data, spentWrap);
    }
    // Re-observe every control against the latest snapshot, then refresh its label and disabled state.
    for (const row of model.rows) {
      const c = controls.get(row.task);
      if (c === undefined) continue;
      if (c.action !== null) c.action.observe(snap);
      c.update(row);
    }
    if (resetControl.action !== null) resetControl.action.observe(snap);
    resetControl.update();
  }

  render();
  return () => { off(); clear(root); };
}

export default { mount } satisfies View;
