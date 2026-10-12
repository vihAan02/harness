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
  const decisions: { text: string | null } = { text: null };

  // Built once: the Action and the buttons survive every re-render, so a pending Approve is never wiped.
  const controls = el('div', { class: 'approval-buttons' });
  const status = el('p', { class: 'approval-status', role: 'status' });
  const approveButton = el('button', { type: 'button', class: 'approve' }, 'Approve');
  const denyButton = el('button', { type: 'button', class: 'deny' }, 'Deny');
  const approve = new Action(() => {
    const list = ctx.approvals();
    const a = list !== null ? list.find((x) => x.id === id) ?? null : null;
    // The hash of what is rendered now: approving binds the click to what the human was shown.
    const model = a !== null ? approvalModel(a, ctx.snapshot()) : null;
    return ctx.api.approve(id, model === null ? '' : model.hash);
  });
  const update = (): void => {
    clear(status);
    if (decisions.text !== null) status.append(decisions.text);
    else if (approve.status === 'conflict') status.append(CONFLICT);
    else status.append(approve.label());
    approveButton.disabled = ctx.offline() !== null || approve.busy();
    denyButton.disabled = ctx.offline() !== null;
  };
  controls.append(approveButton, denyButton);

  listen(approveButton, 'click', () => {
    if (approve.busy()) return;
    decisions.text = null;
    update();
    void approve.send().then(() => {
      if (approve.status === 'conflict') decisions.text = CONFLICT;
      if (approve.status === 'confirmed') decisions.text = GONE_APPROVED;
      update();
      void ctx.refreshApprovals();
    });
  });
  listen(denyButton, 'click', () => {
    decisions.text = GONE_DENIED;
    void ctx.api.deny(id).then(
      () => { void ctx.refreshApprovals(); },
      () => { decisions.text = null; update(); },
    );
    update();
  });

  const off = ctx.onChange(render);
  let lastKey: string | null = null;

  function render(): void {
    const list = ctx.approvals();
    const a = list !== null ? list.find((x) => x.id === id) ?? null : null;
    if (a === null) {
      clear(root);
      // Gone from the list after a send: say what happened; otherwise it was handled elsewhere.
      root.append(el('p', { class: 'plain' }, decisions.text ?? `No pending approval ${id} on this Mac (already handled?).`));
      lastKey = null;
      return;
    }
    const model = approvalModel(a, ctx.snapshot());
    const key = JSON.stringify(model);
    if (key !== lastKey || root.firstChild !== controls) {
      lastKey = key;
      clear(root);
      root.append(...body(model, controls), status);
    }
    update();
  }

  render();
  return () => { off(); clear(root); };
}

export default { mount } satisfies View;
