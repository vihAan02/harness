// One approval's page (D-117, D-112): one local approval shown in full — every row and every long text — before it can
// be approved. The view builds DOM only with dom.ts and sends only through ctx.api inside an Action. Every string is
// untrusted; long text goes into a bordered <pre> as text, set apart by its border and label, never by colour alone.
import { Action } from '../action.ts';
import type { ViewContext, View } from '../app.ts';
import { clear, el, listen } from '../dom.ts';
import { approvalModel } from '../model/approval.ts';
import type { ApprovalModel } from '../model/approval.ts';

const GONE_APPROVED = 'Approved: harnessd acts on it now.';
const GONE_DENIED = 'Denied.';
const CONFLICT = 'This changed after you looked; check it again';

/** The heading, every row, every long text, then the buttons. */
function body(model: ApprovalModel, controls: HTMLElement): (Node | string)[] {
  const out: (Node | string)[] = [
    el('section', { class: 'panel approval-header' },
      el('h2', {}, model.heading),
      el('p', { class: 'approval-task' }, model.task),
      el('p', { class: 'muted approval-kind' }, `kind: ${model.kind}`),
    ),
    el('section', { class: 'panel' },
      el('h2', {}, 'Details'),
      el('dl', { class: 'approval-rows' }, ...model.rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, value)])),
    ),
  ];
  // A long text is set apart by a border and its own label, never by colour alone.
  for (const [label, value] of model.long) {
    out.push(el('section', { class: 'panel approval-long' }, el('h3', {}, label), el('pre', { class: 'long-text' }, value)));
  }
  out.push(el('div', { class: 'approval-actions' }, controls));
  return out;
}

export function mount(root: HTMLElement, ctx: ViewContext): () => void {
  const id = ctx.params[0] ?? '';
  // The hash of the last body we rendered: approving binds the click to what the human was shown, not to a fresh read.
  // `rendered` is false when nothing has been rendered yet.
  const state: { hash: string | null; rendered: boolean; done: string | null } = { hash: null, rendered: false, done: null };

  // Built once: the buttons, the status line and the holder for the current Actions survive every re-render, so a
  // pending send is never wiped and a double click can't send twice. The Actions themselves are created per click (see
  // the click handlers): a conflicted or failed Action is left behind, and a fresh one lets the human try again.
  const controls = el('div', { class: 'approval-buttons' });
  const status = el('p', { class: 'approval-status', role: 'status' });
  const approveButton = el('button', { type: 'button', class: 'approve' }, 'Approve');
  const denyButton = el('button', { type: 'button', class: 'deny' }, 'Deny');

  // The Action created by the last click on each button, kept so its label and busy state can be read every render.
  const actions: { approve: Action | null; deny: Action | null } = { approve: null, deny: null };
  const busy = (action: Action | null): boolean => action !== null && action.busy();
  const eitherBusy = (): boolean => busy(actions.approve) || busy(actions.deny);

  const update = (): void => {
    clear(status);
    // The last sent Action's words win while one is busy, so a send in flight is always visible. A confirmed send
    // shows its outcome; a failed or conflicted one shows the Action's own label (for a conflict, CONFLICT is clearer).
    if (state.done !== null) status.append(state.done);
    else if (actions.approve?.status === 'conflict') status.append(CONFLICT);
    else if (actions.approve !== null && actions.approve.status !== 'idle') status.append(actions.approve.label());
    else if (actions.deny !== null && actions.deny.status !== 'idle') status.append(actions.deny.label());
    approveButton.disabled = ctx.offline() !== null || eitherBusy();
    denyButton.disabled = ctx.offline() !== null || eitherBusy();
  };
  controls.append(approveButton, denyButton);

  // Show the outcome only once the send succeeded and the approval is gone from the list; a failed or conflicted send
  // shows the Action's own label instead.
  const onSend = async (action: Action, success: string): Promise<void> => {
    await action.send();
    update();
    void ctx.refreshApprovals();
    if (action.status === 'confirmed') state.done = success;
    else if (action.status === 'conflict') state.done = null; // update() shows CONFLICT for approve
    else state.done = null; // failed: update() shows the Action's label
    update();
  };

  listen(approveButton, 'click', () => {
    if (eitherBusy()) return;
    // A new Action per click: the previous one may have failed or conflicted, and Action.send() only runs from idle or
    // failed, so reusing it after a conflict would silently do nothing.
    const action = new Action(() => ctx.api.approve(id, state.hash ?? ''));
    actions.approve = action;
    state.done = null;
    update();
    void onSend(action, GONE_APPROVED);
  });
  listen(denyButton, 'click', () => {
    if (eitherBusy()) return;
    const action = new Action(() => ctx.api.deny(id));
    actions.deny = action;
    state.done = null;
    update();
    void onSend(action, GONE_DENIED);
  });

  const off = ctx.onChange(render);
  let lastKey: string | null = null;

  function render(): void {
    const list = ctx.approvals();
    const a = list !== null ? list.find((x) => x.id === id) ?? null : null;
    if (a === null) {
      // Gone from the list after a send: say what happened; otherwise it was handled elsewhere.
      clear(root);
      root.append(el('p', { class: 'plain' }, state.done ?? `No pending approval ${id} on this Mac (already handled?).`));
      lastKey = null;
      state.rendered = false;
      return;
    }
    const model = approvalModel(a, ctx.snapshot());
    const key = JSON.stringify(model);
    // Rebuild the body only when its content changed; the controls live outside the rebuilt body, so focus and a pending
    // send survive. `!root.contains(controls)` (not `firstChild`) is the real "not mounted yet" test.
    if (key !== lastKey || !root.contains(controls)) {
      lastKey = key;
      state.hash = model.hash;
      clear(root);
      root.append(...body(model, controls), status);
      // A conflict is noticed only after a send; a fresh body means the human looked again, so clear it.
      state.done = null;
    }
    update();
  }

  render();
  return () => { off(); clear(root); };
}

export default { mount } satisfies View;
