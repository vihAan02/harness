import { useLayoutEffect, useRef } from 'react'
import { animate } from 'animejs'
import { AlertTriangle, ChevronRight, Columns2, Ellipsis, GitCompare, Lock, MessageSquare, Shield, Users, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { agentById, agents, agentsOnPath, lockOn, memberById, openFile, vendorName, type OpenFile } from '@/data/room'
import { CodeView, FileIcon } from '@/shared/CodeView'
import { reducedMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { RoomWindow } from './RoomWindow'
import { AgentDot, gc, StatusText } from './parts'

const PINNED = ['src/auth/session.ts', 'src/auth/middleware.ts', 'test/api/rooms.test.ts']

export const ROOM_TAB = 'room'

export function Editor({ file, onFile, onAgent, roomTab, focus, onOpenAgent, onNewAgent }: {
  file: string
  onFile: (p: string) => void
  onAgent: (id: string) => void
  /** Option C: the Room window lives as the first editor tab */
  roomTab?: boolean
  focus?: string
  onOpenAgent?: (id: string) => void
  onNewAgent?: () => void
}) {
  const isRoom = file === ROOM_TAB
  const f = openFile(isRoom ? 'src/auth/middleware.ts' : file)
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!scroller.current || reducedMotion()) return
    const a = animate(scroller.current, { opacity: [0.4, 1], duration: 260, ease: 'outQuad' })
    return () => { a.revert() }
  }, [file])

  return (
    <section className="relative flex h-full min-w-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-stretch border-b border-hairline bg-panel">
        {roomTab && (
          <button onClick={() => onFile(ROOM_TAB)}
            className={cn('relative flex items-center gap-2 border-r border-hairline px-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground',
              isRoom && 'bg-background text-foreground')}>
            <Users className="size-3.5" />
            Room
            <span className="size-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />
          </button>
        )}
        {(PINNED.includes(file) || isRoom ? PINNED : [...PINNED, file]).map(p => {
          const on = agentsOnPath(p)
          const active = p === file
          return (
            <button key={p} onClick={() => onFile(p)}
              className={cn('group relative flex items-center gap-2 border-r border-hairline pr-2 pl-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground',
                active && 'bg-background text-foreground')}>
              {active && <span className="absolute inset-x-0 -bottom-px h-px bg-background" />}
              <FileIcon name={p} />
              {p.split('/').pop()}
              {lockOn(p) && <Lock className="size-3 text-muted-foreground" />}
              {p === 'src/auth/middleware.ts' && <span className="size-1.5 rounded-full bg-warn" />}
              <span className="flex -space-x-1">{on.map(a => <AgentDot key={a.id} agent={a} size={12} />)}</span>
              <X className="size-3.5 opacity-0 group-hover:opacity-60" />
            </button>
          )
        })}
        <span className="flex-1" />
        <span className="flex items-center gap-0.5 px-2">
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Split"><Columns2 /></Button>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="More"><Ellipsis /></Button>
        </span>
      </div>

      {isRoom ? (
        <div ref={scroller} className="min-h-0 flex-1">
          <RoomWindow focus={focus ?? 'auth-refactor'} onFocus={onAgent} onOpenAgent={onOpenAgent ?? onAgent} onNewAgent={onNewAgent ?? (() => {})} />
        </div>
      ) : (
      <>
      <Breadcrumbs f={f} />
      <Banner f={f} onAgent={onAgent} />

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto pb-20">
        <CodeView file={f} variant="graphite"
          renderFlag={(id, color) => (
            <span className="absolute top-0 left-[5px] flex h-[18px] items-center rounded-[4px] rounded-tl-none px-1.5 font-sans text-[10.5px] font-semibold whitespace-nowrap text-[#141413] shadow-md shadow-black/40"
              style={{ background: color }}>
              {agentById(id).name}
            </span>
          )}
          renderGhost={g => <GhostHunk g={g} onAgent={onAgent} />}
        />
      </div>

      <ReviewBar />
      </>
      )}
    </section>
  )
}

function Breadcrumbs({ f }: { f: OpenFile }) {
  const parts = f.path.split('/')
  const live = f.live ? agentById(f.live.agent) : undefined
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 px-4 text-[12px] text-muted-foreground">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 text-faint" />}
          <span className={cn(i === parts.length - 1 && 'text-foreground/85')}>{p}</span>
        </span>
      ))}
      {f.path.endsWith('middleware.ts') && <><ChevronRight className="size-3 text-faint" /><span className="font-mono text-[11.5px]">withSession</span></>}
      <span className="flex-1" />
      {live && (
        <span className="flex items-center gap-1.5">
          <AgentDot agent={live} size={12} />
          <StatusText agent={live} className="max-w-[240px]" />
        </span>
      )}
    </div>
  )
}

function Banner({ f, onAgent }: { f: OpenFile; onAgent: (id: string) => void }) {
  const lock = lockOn(f.path)
  const claimant = agents.find(a => a.claims.some(c => f.path.startsWith(c.replace('/**', '/'))))
  const a = lock ?? claimant
  if (!a) return null
  const owner = memberById(a.owner)
  return (
    <div className="mx-3 mb-1 flex h-8 shrink-0 items-center gap-2 rounded-md border border-hairline bg-raised/70 pr-1 pl-2.5 text-[12.5px]">
      {lock ? <Lock className="size-3.5 text-muted-foreground" /> : <Shield className="size-3.5" style={{ color: gc(a) }} />}
      <span className="truncate text-muted-foreground">
        {lock
          ? <>Locked by <b className="font-medium text-foreground">{a.name}</b> while it rewrites this file. Your edits queue until it releases.</>
          : <><span className="font-mono text-foreground/85">{a.claims[0]}</span> is claimed by <b className="font-medium text-foreground">{a.name}</b> ({owner.name} · {vendorName(a.vendor)}). Other agents need a handoff to edit here.</>}
      </span>
      <span className="flex-1" />
      <Button variant="ghost" size="xs" onClick={() => onAgent(a.id)}>View plan</Button>
      <Button variant="ghost" size="xs" onClick={() => onAgent(a.id)}><MessageSquare /> Message</Button>
    </div>
  )
}

function GhostHunk({ g, onAgent }: { g: NonNullable<OpenFile['ghost']>; onAgent: (id: string) => void }) {
  const a = agentById(g.agent)
  const owner = memberById(a.owner)
  return (
    <div className="my-1.5 mr-6 ml-[52px] overflow-hidden rounded-lg border border-dashed font-sans" style={{ borderColor: `${gc(a)}66`, background: `${gc(a)}08` }}>
      <div className="flex items-center gap-2 border-b border-dashed px-2.5 py-1.5 text-[12px]" style={{ borderColor: `${gc(a)}40` }}>
        <AgentDot agent={a} size={13} />
        <span className="font-medium">{a.name}</span>
        <span className="min-w-0 truncate text-muted-foreground">{owner.name} · {vendorName(a.vendor)} · pending in its worktree</span>
        <span className="shrink-0 font-mono text-[11px] text-[#9fd49a]">+4</span>
        {g.overlaps && (
          <span className="flex shrink-0 items-center gap-1 rounded bg-warn/15 px-1.5 py-px text-[11px] font-medium whitespace-nowrap text-warn">
            <AlertTriangle className="size-3" /> overlaps lines {g.overlaps}
          </span>
        )}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => onAgent(a.id)}><MessageSquare /> Thread</Button>
        <Button variant="ghost" size="icon-xs" aria-label="Compare"><GitCompare /></Button>
        <Button variant="secondary" size="xs">Hand off</Button>
      </div>
      <div className="py-1 font-mono text-[12.5px] leading-5">
        {g.lines.map((l, i) => (
          <div key={i} className={cn('flex px-2.5 whitespace-pre', l.t === '+' && 'bg-[#9fd49a]/[0.07] text-[#b9dcaa]', l.t === ' ' && 'text-faint')}>
            <span className="w-4 shrink-0 select-none opacity-60">{l.t === ' ' ? '' : l.t}</span>{l.s}
          </div>
        ))}
      </div>
    </div>
  )
}

function ReviewBar() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!ref.current || reducedMotion()) return
    const a = animate(ref.current, { translateY: [24, 0], opacity: [0, 1], delay: 500, duration: 700, ease: 'outQuint' })
    return () => { a.revert() }
  }, [])
  const busy = agents.filter(a => a.files.length)
  return (
    <div ref={ref} className="absolute bottom-4 left-1/2 flex h-10 -translate-x-1/2 items-center gap-3 rounded-full whitespace-nowrap border bg-popover/95 pr-1.5 pl-3 text-[12.5px] shadow-2xl shadow-black/60 backdrop-blur">
      <span className="flex -space-x-1">{busy.map(a => <AgentDot key={a.id} agent={a} size={16} />)}</span>
      <span><b className="font-medium">{busy.length} agents</b> <span className="text-muted-foreground">changing 9 files</span></span>
      <span className="h-4 w-px bg-border" />
      <span className="flex items-center gap-1 text-warn"><AlertTriangle className="size-3.5" /> 1 conflict</span>
      <span className="text-muted-foreground">1 review waiting</span>
      <Button size="sm" className="h-7 rounded-full">Review <Kbd className="bg-primary-foreground/10 text-primary-foreground">⌘⇧R</Kbd></Button>
    </div>
  )
}
