import { lazy, Suspense, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { GraphiteIDE } from '@/graphite/GraphiteIDE'

const PrismIDE = lazy(() => import('@/prism/PrismIDE').then(m => ({ default: m.PrismIDE })))

type Style = 'graphite' | 'prism' | 'room'
const STYLES: { id: Style; key: string; name: string; blurb: string }[] = [
  { id: 'graphite', key: '1', name: 'A · Graphite', blurb: 'Editor-first, Cursor-style' },
  { id: 'prism', key: '2', name: 'B · Prism', blurb: 'Agent-first mission control' },
  { id: 'room', key: '3', name: 'C · Room', blurb: 'Graphite + the room window' },
]

const fromHash = (): Style => {
  const h = location.hash.slice(1)
  return STYLES.some(s => s.id === h) ? (h as Style) : 'graphite'
}

export default function App() {
  const [style, setStyle] = useState<Style>(fromHash)

  useEffect(() => {
    document.documentElement.className = `dark theme-${style === 'prism' ? 'prism' : 'graphite'}`
    history.replaceState(null, '', `#${style}`)
  }, [style])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey) return
      const s = STYLES.find(x => x.key === e.key)
      if (s) setStyle(s.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <nav className="flex h-8 shrink-0 items-center gap-3 border-b border-white/5 bg-[#050505] px-3 font-sans text-[11.5px] text-neutral-400">
        <span className="font-medium text-neutral-200">Harness UI directions</span>
        <span className="text-neutral-600">prototype · mock room data</span>
        <span className="flex-1" />
        <div className="flex rounded-md border border-white/10 p-0.5">
          {STYLES.map(s => (
            <button key={s.id} onClick={() => setStyle(s.id)}
              className={cn('flex items-center gap-2 rounded px-2.5 py-0.5 transition-colors', style === s.id ? 'bg-white text-black' : 'hover:text-neutral-100')}>
              <span className="font-medium">{s.name}</span>
              <span className={cn(style === s.id ? 'text-black/60' : 'text-neutral-500')}>{s.blurb}</span>
            </button>
          ))}
        </div>
        <span className="text-neutral-600">press 1 / 2 / 3</span>
      </nav>
      <main className="min-h-0 flex-1">
        {style === 'prism'
          ? <Suspense fallback={null}><PrismIDE /></Suspense>
          : <GraphiteIDE key={style} room={style === 'room'} />}
      </main>
    </div>
  )
}
