// The UI's DOM helper (D-117). Elements are built from a tag, plain attributes and children; every string becomes a
// text node, and an attribute that could run code or fetch something is refused outright, not sanitized. Nothing here
// ever sets HTML, a style, or an event-handler attribute: callers attach behaviour with `listen`.

const FORBIDDEN = new Set(['innerhtml', 'outerhtml', 'srcdoc', 'style']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | boolean | undefined>,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === undefined || value === false) continue;
      const lower = name.toLowerCase();
      if (lower.startsWith('on')) throw new Error(`refusing an event-handler attribute: ${name}`);
      if (FORBIDDEN.has(lower)) throw new Error(`refusing an unsafe attribute: ${name}`);
      if (URL_ATTRS.has(lower) && !(typeof value === 'string' && (value.startsWith('#/') || value.startsWith('https://github.com/')))) {
        throw new Error(`refusing a link outside the app: ${name}`);
      }
      node.setAttribute(name, value === true ? '' : value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? text(child) : child);
  }
  return node;
}

/** A text node: the only way a string reaches the page. */
export function text(s: string): Text {
  return document.createTextNode(s);
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function listen(node: EventTarget, type: string, fn: (e: Event) => void): () => void {
  node.addEventListener(type, fn);
  return () => node.removeEventListener(type, fn);
}
