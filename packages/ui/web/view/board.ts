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

/** A new-task form: title, description and scope, each error shown by its own field. */
function newTaskForm(ctx: ViewContext): HTMLElement {
  const titleInput = el('input', { id: 'nt-title', name: 'title', type: 'text', maxlength: '200' });
  const textArea = el('textarea', { id: 'nt-text', name: 'text', rows: '4' });
  const scopeArea = el('textarea', { id: 'nt-scope', name: 'scope', rows: '3' });
  const titleError = el('p', { class: 'error', id: 'nt-title-error' });
  const textError = el('p', { class: 'error', id: 'nt-text-error' });
  const scopeError = el('p', { class: 'error', id: 'nt-scope-error' });
  const status = el('p', { class: 'newtask-status', role: 'status' });
  const create = el('button', { type: 'submit' }, 'Create');

  // A holder: TS can't see a closure reassign a plain `let`, so the action lives in an object field.
  const state: { action: Action | null } = { action: null };

  titleInput.setAttribute('aria-describedby', 'nt-title-error');
  textArea.setAttribute('aria-describedby', 'nt-text-error');
  scopeArea.setAttribute('aria-describedby', 'nt-scope-error');

  const render = (): void => {
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
    const result = newTaskModel({ title: titleInput.value, text: textArea.value, scope: scopeArea.value });
    if (!result.ok) { showErrors(result.errors); return; }
    showErrors({});
    const snap = ctx.snapshot();
    if (snap === null) return;
    const args = result.args;
    const action = new Action((commandId) => ctx.api.command(snap.project_id, 'task.create', args, commandId));
    state.action = action;
    render();
    void action.send().then(() => render());
  };
  listen(form, 'submit', onSubmit);

  // The view re-observes the action on every change; mount calls this.
  (form as HTMLElement & { __observe?: () => void }).__observe = () => {
    const snap = ctx.snapshot();
    if (state.action !== null && snap !== null && state.action.observe(snap)) {
      titleInput.value = ''; textArea.value = ''; scopeArea.value = '';
    }
    render();
  };
  render();
  return form;
}

export function mount(root: HTMLElement, ctx: ViewContext): () => void {
  const render = (): void => {
    const snap = ctx.snapshot();
    if (snap === null) {
      clear(root);
      root.append(el('p', { class: 'muted' }, 'Loading…'));
      return;
    }
    const items = attention(snap, ctx.approvals(), ctx.health(), Date.now());
    const you = items.filter((i) => i.group === 'you');
    const others = items.filter((i) => i.group === 'others');

    const form = newTaskForm(ctx);
    const observe = (form as HTMLElement & { __observe?: () => void }).__observe;

    clear(root);
    root.append(
      attentionSection('Waiting for you', 'Nothing needs you.', you, ctx),
      attentionSection('Waiting on others', 'Nothing waiting on others.', others, ctx),
      presenceSection(snap),
      budgetSection(snap),
      form,
      columnsSection(snap, ctx),
    );
    observe?.();
  };

  const off = ctx.onChange(render);
  render();
  return () => { off(); clear(root); };
}

export default { mount } satisfies View;
