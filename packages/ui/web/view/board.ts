// The board (D-117): the attention queue, every task in its column, who's online, and a new-task form. The view builds
// DOM only with dom.ts and sends only through ctx.api inside an Action. Every string from a snapshot, an approval or the
// health reply is untrusted: it goes into the page as a text node only, and never alone carries meaning that colour
// would (each coloured class has words beside it).
import type { ProjectSnapshot } from '@harness/protocol';
import { Action } from '../action.ts';
import type { ViewContext, View } from '../app.ts';
import { clear, el, listen } from '../dom.ts';
import { attention } from '../model/attention.ts';
import type { AttentionItem } from '../model/attention.ts';
import { COLUMNS, boardModel, newTaskModel } from '../model/board.ts';
import type { Card } from '../model/board.ts';

const LEVEL_WORDS: Record<AttentionItem['level'], string> = { act: 'Act', warn: 'Warning', info: 'FYI' };

function dollars(n: number): string {
  return `$${n.toFixed(3)}`;
}

/** One attention item: a button when it has a route, plain words otherwise. */
function attentionRow(item: AttentionItem, ctx: ViewContext): HTMLElement {
  const body = [el('span', { class: 'badge' }, LEVEL_WORDS[item.level]), el('span', { class: 'attention-title' }, item.title)];
  if (item.detail !== null) body.push(el('span', { class: 'muted attention-detail' }, item.detail));
  if (item.route !== null) {
    const route = item.route;
    const button = el('button', { class: `attention level-${item.level}`, type: 'button' }, ...body);
    listen(button, 'click', () => ctx.navigate(route));
    return button;
  }
  return el('div', { class: `attention level-${item.level}` }, ...body);
}

function attentionSection(title: string, empty: string, items: AttentionItem[], ctx: ViewContext): HTMLElement {
  return el('section', { class: 'panel' },
    el('h2', {}, `${title} (${items.length})`),
    ...(items.length === 0 ? [el('p', { class: 'muted' }, empty)] : items.map((i) => attentionRow(i, ctx))),
  );
}

/** A card: id, title, its plain state words, the detail, its human, agent, device and cost. */
function cardButton(card: Card, ctx: ViewContext): HTMLElement {
  const row: (Node | string | null | false)[] = [
    el('span', { class: 'card-id' }, card.id),
    el('span', { class: 'card-title' }, card.title),
    el('span', { class: 'card-words' }, card.words),
  ];
  if (card.detail !== null) row.push(el('span', { class: 'muted card-detail' }, card.detail));
  row.push(el('span', { class: 'card-meta' },
    el('span', { class: 'card-owner' }, `owner ${card.owner}`),
    card.agent !== null ? el('span', { class: 'card-agent' }, `agent ${card.agent}${card.agentHuman !== null ? ` (${card.agentHuman})` : ''}`) : null,
    card.device !== null ? el('span', { class: 'card-device' }, `${card.device} ${card.deviceOnline === true ? 'online' : 'offline'}`) : null,
    el('span', { class: 'card-cost' }, dollars(card.costUsd)),
  ));
  const button = el('button', { class: 'card', type: 'button' }, ...row);
  listen(button, 'click', () => ctx.navigate(`#/task/${card.id}`));
  return button;
}

function columnsSection(snap: ProjectSnapshot, ctx: ViewContext): HTMLElement {
  const model = boardModel(snap);
  return el('div', { class: 'columns' }, ...model.columns.map((col) =>
    el('section', { class: `column column-${col.key}` },
      el('h3', {}, `${col.title} (${col.cards.length})`),
      ...(col.cards.length === 0 ? [el('p', { class: 'muted' }, 'None')] : col.cards.map((c) => cardButton(c, ctx))),
    ),
  ));
}

function presenceSection(snap: ProjectSnapshot): HTMLElement {
  const model = boardModel(snap);
  return el('section', { class: 'panel presence' },
    el('h2', {}, 'Presence'),
    el('h3', {}, 'Devices'),
    ...(model.devices.length === 0 ? [el('p', { class: 'muted' }, 'None')] : model.devices.map((d) =>
      el('p', { class: 'presence-row' },
        el('span', { class: 'device-name' }, d.id),
        el('span', { class: `dot ${d.online ? 'online' : 'offline'}` }, d.online ? 'online' : 'offline'),
        d.mine ? el('span', { class: 'muted' }, 'this Mac') : null,
      ),
    )),
    el('h3', {}, 'Agents'),
    ...(model.agents.length === 0 ? [el('p', { class: 'muted' }, 'None')] : model.agents.map((a) =>
      el('p', { class: 'presence-row' },
        el('span', { class: 'agent-name' }, a.name),
        el('span', { class: 'muted' }, a.human),
        a.device !== null ? el('span', { class: 'muted' }, a.device) : null,
        el('span', { class: 'agent-state' }, a.taskId !== null ? `busy with ${a.taskId}` : 'idle'),
      ),
    )),
  );
}

function budgetSection(snap: ProjectSnapshot): HTMLElement {
  const { budget } = boardModel(snap);
  const line = budget.daily === null
    ? 'No daily budget set'
    : `$${budget.spent.toFixed(2)} of $${budget.daily.toFixed(2)} today`;
  const words = budget.level === 'over' ? 'over budget' : budget.level === 'warn' ? 'close to budget' : null;
  return el('section', { class: 'panel budget' },
    el('h2', {}, 'Budget'),
    el('p', { class: `budget-line level-${budget.level}` }, line, words !== null ? el('span', { class: `budget-words level-${budget.level}` }, ` — ${words}`) : null),
  );
}

/** A new-task form: title, description and scope, each error shown by its own field. Built once; its Action and typed
 * text survive every re-render, so a pending Create is never wiped and a second click can't double-send. */
function newTaskForm(ctx: ViewContext): { form: HTMLElement; update: () => void } {
  const titleInput = el('input', { id: 'nt-title', name: 'title', type: 'text', maxlength: '200' });
  const textArea = el('textarea', { id: 'nt-text', name: 'text', rows: '4' });
  const scopeArea = el('textarea', { id: 'nt-scope', name: 'scope', rows: '3' });
  const titleError = el('p', { class: 'error', id: 'nt-title-error' });
  const textError = el('p', { class: 'error', id: 'nt-text-error' });
  const scopeError = el('p', { class: 'error', id: 'nt-scope-error' });
  const status = el('p', { class: 'newtask-status', role: 'status' });
  const create = el('button', { type: 'submit' }, 'Create');

  // A holder: TS can't see a closure reassign a plain `let`, so the action lives in an object field. `cleared` marks
  // the one Action we've already cleared the inputs for, so confirmation doesn't clear a fresh submission's text.
  const state: { action: Action | null; cleared: Action | null } = { action: null, cleared: null };

  titleInput.setAttribute('aria-describedby', 'nt-title-error');
  textArea.setAttribute('aria-describedby', 'nt-text-error');
  scopeArea.setAttribute('aria-describedby', 'nt-scope-error');

  // Clear the inputs exactly once per confirmed Action, however confirmation arrived (observe(), or a reply with no
  // seqs). The mark makes it once: a later re-render won't re-clear what the human has since typed.
  const clearOnConfirm = (): void => {
    if (state.action !== null && state.action.status === 'confirmed' && state.cleared !== state.action) {
      state.cleared = state.action;
      titleInput.value = ''; textArea.value = ''; scopeArea.value = '';
    }
  };

  // Re-observed against the latest snapshot on every change; the inputs clear only when the action confirms.
  const update = (): void => {
    const snap = ctx.snapshot();
    if (state.action !== null && snap !== null) state.action.observe(snap);
    clearOnConfirm();
    clear(status);
    if (state.action !== null) status.append(state.action.label());
    create.disabled = ctx.offline() !== null || (state.action !== null && state.action.busy());
  };

  const showErrors = (errors: Record<string, string>): void => {
    clear(titleError); if (errors.title) titleError.append(errors.title);
    clear(textError); if (errors.text) textError.append(errors.text);
    clear(scopeError); if (errors.scope) scopeError.append(errors.scope);
  };

  const form = el('form', { class: 'newtask', novalidate: true },
    el('h2', {}, 'New task'),
    el('label', { for: 'nt-title' }, 'Title'),
    titleInput, titleError,
    el('label', { for: 'nt-text' }, 'Description'),
    textArea, textError,
    el('label', { for: 'nt-scope' }, 'Scope (paths, one per line or comma-separated)'),
    scopeArea, scopeError,
    create, status,
  );

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    // Only a pending Action blocks a new submit; a failed, conflicted or confirmed one doesn't, so a later task can
    // still be created with the form as-is.
    if (state.action !== null && state.action.busy()) return;
    const result = newTaskModel({ title: titleInput.value, text: textArea.value, scope: scopeArea.value });
    if (!result.ok) { showErrors(result.errors); return; }
    showErrors({});
    const snap = ctx.snapshot();
    if (snap === null) return;
    const args = result.args;
    const action = new Action((commandId) => ctx.api.command(snap.project_id, 'task.create', args, commandId));
    state.action = action;
    update();
    void action.send().then(() => {
      // A reply with no seqs confirms immediately; observe() never sees that, so clear here too. observe()-confirmed
      // actions clear in update(), which runs right after.
      clearOnConfirm();
      update();
    });
  };
  listen(form, 'submit', onSubmit);

  update();
  return { form, update };
}

/** The board's data: the two attention lists and the columns. It is rebuilt only when its content changed, so a
 * re-render every few seconds doesn't steal focus from a card or an attention button. */
function dataContainer(snap: ProjectSnapshot, items: AttentionItem[], ctx: ViewContext): HTMLElement {
  const you = items.filter((i) => i.group === 'you');
  const others = items.filter((i) => i.group === 'others');
  return el('div', { class: 'board-data' },
    attentionSection('Waiting for you', 'Nothing needs you.', you, ctx),
    attentionSection('Waiting on others', 'Nothing waiting on others.', others, ctx),
    columnsSection(snap, ctx),
  );
}

export function mount(root: HTMLElement, ctx: ViewContext): () => void {
  // The form is built once, outside render, so typed text, focus and a pending Create survive every change.
  const { form, update } = newTaskForm(ctx);
  const data = el('div', { class: 'board-data-wrap' });
  const off = ctx.onChange(render);
  let lastKey: string | null = null;

  function render(): void {
    const snap = ctx.snapshot();
    if (snap === null) {
      clear(root);
      root.append(el('p', { class: 'muted' }, 'Loading…'));
      lastKey = null;
      return;
    }
    const items = attention(snap, ctx.approvals(), ctx.health(), Date.now());
    const board = boardModel(snap);
    // Rebuild the data only when what it shows changed; the two models are the whole of what it shows.
    const key = JSON.stringify({ items, board });
    if (key !== lastKey) {
      lastKey = key;
      clear(data);
      data.append(
        dataContainer(snap, items, ctx),
        presenceSection(snap),
        budgetSection(snap),
      );
    }
    // The chrome is rebuilt once; only the data and the form's live state change thereafter.
    if (root.firstChild !== data) {
      clear(root);
      root.append(data, form);
    }
    update();
  }

  render();
  return () => { off(); clear(root); };
}

export default { mount } satisfies View;
