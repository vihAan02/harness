import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate } from 'animejs'
import { agentById } from '@/data/room'
import { reducedMotion } from '@/lib/motion'
import { NewAgentDialog } from '@/shared/NewAgentDialog'
import { EditorView, PrismTree, ReviewView } from './EditorView'
import { Inspector } from './Inspector'
import { CommandBar, PeopleRail, TopBar, type Mode } from './parts'
import { RoomView } from './RoomView'

/**
 * Direction B · Prism. Agent-first: the room is the home screen, the editor is one mode of it.
 * Pure black, spectral agent light rendered with WebGPU (vgpu), serif display type, mono labels.
 */
export function PrismIDE() {
  const [mode, setMode] = useState<Mode>('room')
  const [focus, setFocus] = useState('auth-refactor')
  const [file, setFile] = useState('src/auth/middleware.ts')
  const [newAgent, setNewAgent] = useState(false)
  const center = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!center.current || reducedMotion()) return
    const a = animate(center.current, { opacity: [0, 1], translateY: [10, 0], duration: 520, ease: 'outQuart' })
    return () => { a.revert() }
  }, [mode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea') || e.metaKey || e.ctrlKey) return
      if (e.key === 'r') setMode('room')
      if (e.key === 'e') setMode('editor')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TopBar mode={mode} onMode={setMode} />
      <div className="flex min-h-0 flex-1">
        <div className="w-[272px] shrink-0 border-r border-hairline">
          {mode === 'editor'
            ? <PrismTree file={file} onFile={setFile} />
            : <PeopleRail focus={focus} onFocus={setFocus} onNewAgent={() => setNewAgent(true)} />}
        </div>
        <div className="relative min-w-0 flex-1">
          <div ref={center} className="h-full">
            {mode === 'room' && <RoomView focus={focus} onFocus={setFocus} />}
            {mode === 'editor' && <EditorView file={file} onFile={setFile} onFocus={setFocus} />}
            {mode === 'review' && <ReviewView onFocus={setFocus} />}
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
            <CommandBar target={mode === 'room' ? undefined : agentById(focus)} />
          </div>
        </div>
        <div className="w-[352px] shrink-0 border-l border-hairline max-[1180px]:hidden">
          <Inspector agentId={focus} />
        </div>
      </div>
      <NewAgentDialog open={newAgent} onOpenChange={setNewAgent} variant="prism" />
    </div>
  )
}
