// A tiny line-level TypeScript highlighter, enough for the prototype's code views.
import type { ReactNode } from 'react'

const KW = new Set(('import export from type interface const let var function return async await if else try catch ' +
  'new throw class extends implements for of in while do switch case break continue default as typeof keyof void ' +
  'null undefined true false this').split(' '))
const TYPES = new Set('string number boolean Promise Request Handler Session SessionHooks Omit Record'.split(' '))

const RE = /(\/\/.*$|\/\*.*?\*\/)|('(?:\\.|[^'])*'|"(?:\\.|[^"])*"|`(?:\\.|[^`])*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d'"`]+)/g

export function highlight(line: string): ReactNode[] {
  const out: ReactNode[] = []
  let m: RegExpExecArray | null
  let i = 0
  RE.lastIndex = 0
  while ((m = RE.exec(line))) {
    const [text, com, str, num, id, ws] = m
    const k = i++
    if (com) out.push(<span key={k} className="tok-com">{text}</span>)
    else if (str) out.push(<span key={k} className="tok-str">{text}</span>)
    else if (num) out.push(<span key={k} className="tok-num">{text}</span>)
    else if (id) {
      const next = line.slice(RE.lastIndex).trimStart()
      const prev = line.slice(0, m.index).trimEnd()
      const cls = KW.has(id) ? 'tok-kw'
        : TYPES.has(id) || /^[A-Z]/.test(id) ? 'tok-type'
        : next.startsWith('(') || next.startsWith('?.(') ? 'tok-fn'
        : prev.endsWith('.') ? 'tok-prop'
        : 'tok-id'
      out.push(<span key={k} className={cls}>{text}</span>)
    } else if (ws) out.push(text)
    else out.push(<span key={k} className="tok-punct">{text}</span>)
  }
  return out
}
