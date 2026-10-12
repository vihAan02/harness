// The UI's DOM helper (D-117). A tiny fake document stands in for the browser's: no DOM is needed, only the shape
// dom.ts uses (createElement, createTextNode, setAttribute, append, firstChild/removeChild).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clear, el, listen, text } from '../web/dom.ts';

class FakeText {
  nodeType = 3;
  data: string;
  constructor(data: string) { this.data = data; }
}

class FakeEl {
  attrs = new Map<string, string>();
  childNodes: unknown[] = [];
  listeners = new Map<string, Array<(e: Event) => void>>();
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(name: string, value: string): void { this.attrs.set(name.toLowerCase(), value); }
  getAttribute(name: string): string | null { const v = this.attrs.get(name.toLowerCase()); return v === undefined ? null : v; }
  append(...nodes: unknown[]): void { for (const n of nodes) this.childNodes.push(n); }
  get firstChild(): unknown { return this.childNodes[0] ?? null; }
  removeChild(node: unknown): void { const i = this.childNodes.indexOf(node); if (i >= 0) this.childNodes.splice(i, 1); }
  addEventListener(type: string, fn: (e: Event) => void): void { const a = this.listeners.get(type) ?? []; a.push(fn); this.listeners.set(type, a); }
  removeEventListener(type: string, fn: (e: Event) => void): void { const a = this.listeners.get(type) ?? []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
}

function fakeDocument(): () => void {
  const g = globalThis as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (s: string) => new FakeText(s),
  };
  return () => { delete g.document; };
}

const asEl = (n: unknown) => n as unknown as FakeEl;
const asText = (n: unknown) => n as unknown as FakeText;

test('el builds an element; strings become text nodes; false and undefined attrs are skipped', () => {
  const done = fakeDocument();
  const node = asEl(el('div', { id: 'x', hidden: true, title: undefined, draggable: false }, 'a "b" <c>', el('span'), null, false));
  assert.equal(node.tagName, 'div');
  assert.equal(node.getAttribute('id'), 'x');
  assert.equal(node.getAttribute('hidden'), '', 'true is an empty attribute');
  assert.equal(node.getAttribute('title'), null);
  assert.equal(node.getAttribute('draggable'), null);
  assert.equal(node.childNodes.length, 2, 'null and false children are skipped');
  const first = asText(node.childNodes[0]);
  assert.equal(first.nodeType, 3);
  assert.equal(first.data, 'a "b" <c>', 'the string is a text node, not markup');
  assert.equal(asEl(node.childNodes[1]).tagName, 'span');
  done();
});

test('el refuses event-handler, style and HTML attributes', () => {
  const done = fakeDocument();
  for (const attrs of [{ onclick: 'x' }, { onMouseOver: 'x' }, { style: 'color:red' }, { innerHTML: 'x' }, { outerHTML: 'x' }, { srcdoc: 'x' }]) {
    assert.throws(() => el('div', attrs as never), /refusing/i);
  }
  done();
});

test('el refuses links outside the app and the repo, and allows #/ and github.com', () => {
  const done = fakeDocument();
  assert.throws(() => el('a', { href: 'javascript:alert(1)' }), /refusing/i);
  assert.throws(() => el('a', { href: 'http://evil.example/' }), /refusing/i);
  assert.throws(() => el('a', { href: 'https://github.com.evil.example/x' }), /refusing/i);
  assert.throws(() => el('img', { src: '/etc/passwd' }), /refusing/i);
  const link = asEl(el('a', { href: '#/task/T-1' }));
  assert.equal(link.getAttribute('href'), '#/task/T-1');
  const pr = asEl(el('a', { href: 'https://github.com/vihAan02/harness/pull/1' }));
  assert.equal(pr.getAttribute('href'), 'https://github.com/vihAan02/harness/pull/1');
  done();
});

test('text and clear', () => {
  const done = fakeDocument();
  const node = asText(text('hello'));
  assert.equal(node.nodeType, 3);
  assert.equal(node.data, 'hello');
  const box = asEl(el('div', {}, 'one', 'two'));
  assert.equal(box.childNodes.length, 2);
  clear(box as unknown as Node);
  assert.equal(box.childNodes.length, 0);
  assert.equal(box.firstChild, null);
  done();
});

test('listen adds a listener and returns an unsubscribe', () => {
  const done = fakeDocument();
  const node = asEl(el('button', {}, 'go'));
  const off = listen(node as unknown as EventTarget, 'click', () => {});
  assert.equal(node.listeners.get('click')?.length, 1);
  off();
  assert.equal(node.listeners.get('click')?.length, 0);
  done();
});
