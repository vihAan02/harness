import { useRef, useState } from 'react'
import { ArrowUp, AtSign, ChevronDown, Copy, GitBranch, Plus, Settings2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { agents, members, room, type Agent } from '@/data/room'
import { ShaderOrb } from '@/gpu/components'
import { useStaggerIn } from '@/lib/motion'
import { cn } from '@/lib/utils'

export const pc = (a: Agent) => a.color.prism

export function Orb({ agent, size = 18, className }: { agent: Agent; size?: number; className?: string }) {
  return <ShaderOrb color={pc(agent)} status={agent.status} size={size} seed={agents.indexOf(agent) + 1} className={className} />
}

export function Micro({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <span className={cn('micro', className)} style={style}>{children}</span>
}

const STATUS_MICRO: Record<Agent['status'], string> = {
  editing: 'EDITING', running: 'RUNNING', thinking: 'THINKING', blocked: 'BLOCKED', waiting_review: 'REVIEW', idle: 'IDLE',
}
export function statusMicro(a: Agent) {
  const warn = a.status === 'blocked' || a.status === 'waiting_review'
  const where = a.status === 'editing' ? 'MIDDLEWARE.TS' : a.status === 'running' ? 'NPM TEST' : a.status === 'thinking' ? 'PLANNING' : a.status === 'waiting_review' ? 'MIGRATE DEPLOY' : 'SRC/AUTH CLAIM'
  return <Micro className={cn(warn ? 'text-warn' : '')} style={warn ? undefined : { color: pc(a) }}>{STATUS_MICRO[a.status]} · {where}</Micro>
}

export function PlanBar({ agent, className }: { agent: Agent; className?: string }) {
  return (
    <span className={cn('flex gap-[3px]', className)}>
      {agent.plan.steps.map((s, i) => (
        <span key={i} className="h-[3px] flex-1 rounded-full"
          style={{
            background: s.state === 'todo' ? 'rgb(255 255 255 / 0.1)' : pc(agent),
            opacity: s.state === 'active' ? 0.5 : 1,
            boxShadow: s.state === 'done' ? `0 0 6px ${pc(agent)}80` : undefined,
          }} />
      ))}
    </span>
  )
}

export type Mode = 'room' | 'editor' | 'review'

export function PrismLogo() {
  return (
    <svg viewBox="0 0 24 22" className="size-[18px]" aria-hidden>
      <defs>
        <linearGradient id="prism-g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#ff6b4a" /><stop offset=".35" stopColor="#ffb547" />
          <stop offset=".6" stopColor="#5ee89b" /><stop offset=".8" stopColor="#4fd6ff" /><stop offset="1" stopColor="#a98bff" />
        </linearGradient>
      </defs>
      <path d="M12 1.5 22.5 20.5H1.5Z" fill="none" stroke="url(#prism-g)" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 1.5 22.5 20.5H1.5Z" fill="#fff" fillOpacity=".06" />
    </svg>
  )
}

export function TopBar({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-4 select-none">
      <div className="flex items-center gap-1.5 pr-3">
        {['#ff5f57', '#febc2e', '#28c840'].map(c => <span key={c} className="size-3 rounded-full opacity-90" style={{ background: c }} />)}
      </div>
      <PrismLogo />
      <span className="text-faint">/</span>
      <span className="font-serif text-[21px] leading-none tracking-tight">harness</span>
      <span className="text-faint">/</span>
      <button className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] hover:bg-white/5">
        {room.name} <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>
      <Micro className="flex items-center gap-1 text-muted-foreground"><GitBranch className="size-3" /> main</Micro>

      <div className="flex flex-1 justify-center">
        <ToggleGroup type="single" value={mode} onValueChange={v => v && onMode(v as Mode)}
          className="rounded-full border border-white/10 p-0.5">
          {([['room', 'Room'], ['editor', 'Editor'], ['review', 'Review']] as const).map(([id, label]) => (
            <ToggleGroupItem key={id} value={id}
              className="h-7 rounded-full! px-4 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase data-[state=on]:bg-white data-[state=on]:text-black">
              {label}{id === 'review' && <span className="ml-1.5 rounded-full bg-warn px-1 text-[9.5px] text-black">2</span>}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex -space-x-1.5">
          {members.map((m, i) => (
            <span key={m.id} className="grid size-7 place-items-center rounded-full border border-black bg-[#111] font-mono text-[10px] text-foreground"
              style={{ boxShadow: `inset 0 0 0 1px ${pc(agents.filter(a => a.owner === m.id)[0])}`, zIndex: 3 - i }}>{m.initials}</span>
          ))}
        </div>
        <Button variant="outline" size="sm" className="h-8 rounded-full border-white/15 bg-transparent px-3"><UserPlus /> Invite</Button>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Settings"><Settings2 /></Button>
      </div>
    </header>
  )
}

export function PeopleRail({ focus, onFocus, onNewAgent }: { focus: string; onFocus: (id: string) => void; onNewAgent: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useStaggerIn(ref, '[data-row]', [], { step: 45, y: 8 })
  return (
    <aside ref={ref} className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <Micro className="text-muted-foreground">People &amp; agents <span className="text-faint">· {members.length} · {agents.length}</span></Micro>
        <Button variant="ghost" size="xs" className="font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase" onClick={onNewAgent}><Plus /> New</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-3">
        {members.map(m => (
          <div key={m.id} className="mb-3">
            <div data-row className="flex items-center gap-2 px-1.5 py-1.5">
              <span className="grid size-5 place-items-center rounded-full bg-[#141414] font-mono text-[9px]">{m.initials}</span>
              <span className="text-[13px]">{m.name}</span>
              {m.you && <Micro className="text-faint">this device</Micro>}
            </div>
            {agents.filter(a => a.owner === m.id).map(a => {
              const on = focus === a.id
              return (
                <button key={a.id} data-row onClick={() => onFocus(a.id)}
                  className={cn('relative mb-1 grid w-full gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors',
                    on ? 'border-white/15 bg-white/[0.035]' : 'border-transparent hover:bg-white/[0.025]')}>
                  {on && <span className="absolute top-3 bottom-3 -left-px w-px" style={{ background: pc(a), boxShadow: `0 0 8px ${pc(a)}` }} />}
                  <span className="flex items-center gap-2.5">
                    <Orb agent={a} size={20} />
                    <span className="text-[13.5px] font-medium">{a.name}</span>
                    <Micro className="ml-auto text-faint">{a.vendor}</Micro>
                  </span>
                  {statusMicro(a)}
                  <PlanBar agent={a} />
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="m-2.5 mt-0 grid gap-1.5 rounded-lg border border-hairline p-3">
        <span className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-ok shadow-[0_0_8px_var(--ok)]" />
          <Micro>Room live</Micro>
          <Micro className="ml-auto text-faint">{room.relay}</Micro>
        </span>
        <button className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground hover:text-foreground">
          <Copy className="size-3" /> {room.invite}
        </button>
      </div>
    </aside>
  )
}

export function CommandBar({ target }: { target?: Agent }) {
  const [value, setValue] = useState('')
  return (
    <div className="pointer-events-auto flex h-12 w-[min(560px,92%)] items-center gap-2 rounded-full border border-white/12 bg-black/75 pr-1.5 pl-2 shadow-[0_20px_60px_-10px_rgb(0_0_0/0.9)] backdrop-blur-xl">
      <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-white/10 pr-2.5 pl-1.5">
        {target ? <Orb agent={target} size={16} /> : <AtSign className="size-3.5 text-muted-foreground" />}
        <Micro>{target ? target.name : 'room'}</Micro>
      </span>
      <input value={value} onChange={e => setValue(e.target.value)}
        placeholder={target ? `Message ${target.name}, or @ another agent…` : 'Message the room, or @agent…'}
        className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint" />
      <Kbd className="bg-white/5 font-mono">⌘J</Kbd>
      <Button size="icon-sm" className="rounded-full" aria-label="Send"><ArrowUp /></Button>
    </div>
  )
}
