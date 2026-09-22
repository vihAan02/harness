import { useRef, useState } from 'react'
import {
  ArrowUp, AtSign, Check, ChevronDown, ChevronRight, Circle, CircleDot, Eye, FilePen, History, Infinity as InfinityIcon, Loader2, Lock,
  MessageSquareReply, Paperclip, Plus, Terminal, Users, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { agentById, agents, comms, KIND_LABEL, memberById, partyName, streams, vendorName, type Agent, type StreamEvent } from '@/data/room'
import { useStaggerIn } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { AgentDot, gc, StatusText } from './parts'

export function AgentPanel({ focus, onFocus, onNewAgent, onClose }: {
  focus: string; onFocus: (id: string) => void; onNewAgent: () => void; onClose?: () => void
}) {
  const agent = focus === 'room' ? undefined : agentById(focus)
  return (
    <aside className="flex h-full min-w-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-hairline pr-1.5 pl-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          <Chip on={focus === 'room'} onClick={() => onFocus('room')}><Users className="size-3.5" /> Room</Chip>
          {agents.map(a => (
            <Chip key={a.id} on={focus === a.id} onClick={() => onFocus(a.id)}>
              <AgentDot agent={a} size={12} /> {a.name}
            </Chip>
          ))}
        </div>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onNewAgent} aria-label="New agent"><Plus /></Button>
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="History"><History /></Button>
        {onClose && <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onClose} aria-label="Hide agent panel"><X /></Button>}
      </div>
      {agent ? <AgentView key={agent.id} agent={agent} /> : <RoomFeed onFocus={onFocus} />}
      <Composer agent={agent} />
    </aside>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground',
        on && 'bg-accent text-foreground')}>
      {children}
    </button>
  )
}

function AgentView({ agent }: { agent: Agent }) {
  const ref = useRef<HTMLDivElement>(null)
  useStaggerIn(ref, '[data-ev]', [agent.id])
  const [planOpen, setPlanOpen] = useState(true)
  const done = agent.plan.steps.filter(s => s.state === 'done').length
  const owner = memberById(agent.owner)
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto">
      <div className="grid gap-2.5 border-b border-hairline px-4 py-3" data-ev>
        <div className="flex items-center gap-2.5">
          <AgentDot agent={agent} size={26} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-semibold">{agent.name}</span>
              <span className="rounded border px-1.5 text-[10.5px] font-medium text-muted-foreground">{vendorName(agent.vendor)}</span>
            </div>
            <div className="truncate text-xs text-muted-foreground">{owner.name}{owner.you ? ' (this device)' : ''} · <span className="font-mono">{agent.branch}</span></div>
          </div>
        </div>
        <StatusText agent={agent} className="text-[12.5px]" />
        <button onClick={() => setPlanOpen(o => !o)} className="flex items-center gap-2 text-left text-[12.5px]">
          {planOpen ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
          <span className="font-medium">Plan</span>
          <span className="truncate text-muted-foreground">{agent.plan.title}</span>
          <span className="ml-auto flex items-center gap-2 text-muted-foreground">
            <span className="flex gap-0.5">
              {agent.plan.steps.map((s, i) => (
                <span key={i} className="h-1 w-3 rounded-full" style={{ background: s.state === 'todo' ? 'var(--muted)' : gc(agent), opacity: s.state === 'active' ? 0.55 : 1 }} />
              ))}
            </span>
            {done}/{agent.plan.steps.length}
          </span>
        </button>
        {planOpen && (
          <ol className="grid gap-1 pl-5.5">
            {agent.plan.steps.map((s, i) => (
              <li key={i} className={cn('grid gap-0.5 text-[12.5px]', s.state === 'todo' && 'text-muted-foreground', s.state === 'done' && 'text-muted-foreground')}>
                <span className="flex items-center gap-2">
                  {s.state === 'done' ? <Check className="size-3.5 text-ok" />
                    : s.state === 'active' ? <CircleDot className="size-3.5" style={{ color: gc(agent) }} />
                    : s.state === 'blocked' ? <Lock className="size-3.5 text-warn" />
                    : <Circle className="size-3.5 text-faint" />}
                  <span className={cn(s.state === 'active' && 'text-foreground', s.state === 'done' && 'line-through decoration-faint', s.state === 'blocked' && 'text-warn/90')}>{s.title}</span>
                </span>
                {s.waitsOn && (
                  <span className="pl-5.5 text-[11px] text-muted-foreground">
                    waits on <b className="font-medium text-foreground/80">{agentById(s.waitsOn.agent).name}</b> · {s.waitsOn.why}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        {agent.claims.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Claims {agent.claims.map(c => <span key={c} className="rounded border px-1.5 font-mono text-[11px] text-foreground/80">{c}</span>)}
          </div>
        )}
      </div>
      <div className="grid gap-1 px-3 py-3">
        {(streams[agent.id] ?? []).map((e, i) => <Event key={i} e={e} agent={agent} />)}
      </div>
    </div>
  )
}

const TOOL_ICON: Record<string, React.ReactNode> = {
  Read: <Eye />, Edit: <FilePen />, Write: <FilePen />, Bash: <Terminal />, mp_ask: <MessageSquareReply />,
}
const TOOL_VERB: Record<string, string> = { Read: 'Read', Edit: 'Edited', Write: 'Created', Bash: 'Ran', mp_ask: 'Asked' }

function Event({ e, agent }: { e: StreamEvent; agent: Agent }) {
  switch (e.kind) {
    case 'prompt':
      return (
        <div data-ev className="mb-1.5 rounded-lg border bg-raised px-3 py-2 text-[13px] leading-relaxed">
          <div className="mb-0.5 text-[11px] text-muted-foreground">{memberById(agent.owner).name} · {e.at}</div>
          {e.text}
        </div>
      )
    case 'say':
      return <p data-ev className="px-1 py-1.5 text-[13px] leading-relaxed text-foreground/90">{e.text}</p>
    case 'tool':
      return (
        <div data-ev className="group flex h-7 items-center gap-2 rounded-md px-1.5 text-[12.5px] text-muted-foreground hover:bg-accent/50 [&>svg]:size-3.5">
          {TOOL_ICON[e.tool] ?? <Terminal />}
          <span>{TOOL_VERB[e.tool] ?? e.tool}</span>
          <span className="truncate font-mono text-[12px] text-foreground/85">{e.target}</span>
          {e.detail && (
            <span className={cn('shrink-0 font-mono text-[11.5px]', e.ok === false && 'text-warn', e.ok === true && 'text-ok')}>
              {e.detail.split(' ').map((d, i) => <span key={i} className={cn(d.startsWith('+') && 'text-[#9fd49a]', d.startsWith('−') && 'text-[#ef8f8f]')}>{d} </span>)}
            </span>
          )}
          <span className="ml-auto shrink-0">{e.live ? <Loader2 className="size-3.5 animate-spin" style={{ color: gc(agent) }} /> : <span className="text-[11px] text-faint">{e.at}</span>}</span>
        </div>
      )
    case 'coord':
      return (
        <div data-ev className="flex items-center gap-2 px-1.5 py-1 text-[12px] text-muted-foreground">
          <span className="rounded bg-secondary px-1 text-[10px] font-semibold tracking-wide">ROOM</span>
          <span className="truncate">{e.text}</span>
          <span className="ml-auto text-[11px] text-faint">{e.at}</span>
        </div>
      )
    case 'inbox': {
      const fromAgent = agents.find(a => a.id === e.from)
      const color = fromAgent ? gc(fromAgent) : 'var(--muted-foreground)'
      return (
        <div data-ev className="my-1.5 rounded-lg border px-3 py-2" style={{ borderColor: `${color}55`, background: `${color}0a` }}>
          <div className="mb-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            {fromAgent ? <AgentDot agent={fromAgent} size={12} /> : <AtSign className="size-3" />}
            <span className="font-medium text-foreground">{fromAgent?.name ?? memberById(e.from).name}</span> → {agent.name} · {e.at}
          </div>
          <p className="text-[13px] leading-relaxed">{e.text}</p>
          <div className="mt-2 flex gap-1.5">
            <Button size="xs" variant="secondary"><MessageSquareReply /> Reply</Button>
            <Button size="xs" variant="ghost">Open thread</Button>
          </div>
        </div>
      )
    }
  }
}

function RoomFeed({ onFocus }: { onFocus: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useStaggerIn(ref, '[data-ev]', [])
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto px-3 py-3">
      <div data-ev className="mb-3 grid grid-cols-5 gap-1.5">
        {agents.map(a => (
          <button key={a.id} onClick={() => onFocus(a.id)} className="grid justify-items-center gap-1.5 rounded-lg border border-hairline py-2.5 hover:bg-accent/50">
            <AgentDot agent={a} size={22} />
            <span className="w-full truncate px-1 text-center text-[11px]">{a.name}</span>
          </button>
        ))}
      </div>
      {comms.map(m => {
        const a = m.from.type === 'agent' ? agentById(m.from.id) : undefined
        const to = m.to.length ? m.to.map(partyName).join(', ') : 'the room'
        return (
          <div data-ev key={m.id} className="flex gap-2.5 rounded-lg px-1.5 py-2 hover:bg-accent/40">
            {a ? <AgentDot agent={a} size={20} className="mt-0.5" /> : (
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-secondary text-[8.5px] font-bold">
                {m.from.type === 'member' ? memberById(m.from.id).initials : 'H'}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[12px]">
                <span className="font-medium">{partyName(m.from)}</span>
                <span className="truncate text-muted-foreground">→ {to}</span>
                <span className={cn('rounded px-1 text-[10px] font-semibold',
                  m.kind === 'review' || m.kind === 'denied' ? 'bg-warn/15 text-warn' : 'bg-secondary text-muted-foreground')}>
                  {KIND_LABEL[m.kind]}
                </span>
                <span className="ml-auto text-[11px] text-faint">{m.at}</span>
              </div>
              <p className="mt-0.5 text-[13px] leading-relaxed text-foreground/90">{m.body}</p>
              {m.kind === 'review' && (
                <div className="mt-2 flex gap-1.5">
                  <Button size="xs"><Check /> Approve</Button>
                  <Button size="xs" variant="secondary">Ask a reviewer agent</Button>
                  <Button size="xs" variant="ghost"><X /> Deny</Button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Composer({ agent }: { agent?: Agent }) {
  const [mode, setMode] = useState('Agent')
  return (
    <div className="shrink-0 p-2.5 pt-0">
      <div className="rounded-xl border bg-raised shadow-lg shadow-black/30 transition-colors focus-within:border-ring/50">
        <div className="flex flex-wrap gap-1 px-2.5 pt-2.5">
          <span className="flex h-5 items-center gap-1 rounded border bg-background/50 px-1.5 font-mono text-[11px] text-muted-foreground"><AtSign className="size-3" />middleware.ts</span>
          {agent && agent.id === 'auth-refactor' && (
            <span className="flex h-5 items-center gap-1 rounded border bg-background/50 px-1.5 text-[11px] text-muted-foreground"><AgentDot agent={agentById('rate-limit')} size={10} />rate-limit</span>
          )}
        </div>
        <textarea rows={2} placeholder={agent ? `Message ${agent.name} — @ to bring in another agent or person` : 'Message the room — @agent or @person'}
          className="block w-full resize-none bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-faint" />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" size="xs" className="rounded-full"><InfinityIcon /> {mode} <ChevronDown /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {['Agent', 'Plan', 'Ask'].map(m => <DropdownMenuItem key={m} onSelect={() => setMode(m)}>{m}</DropdownMenuItem>)}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="xs" className="text-muted-foreground">{agent ? `To ${agent.name}` : 'To everyone'} <ChevronDown /></Button>
          <span className="flex-1" />
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Attach"><Paperclip /></Button>
          <Button size="icon-xs" className="rounded-full" aria-label="Send"><ArrowUp /></Button>
        </div>
      </div>
    </div>
  )
}
