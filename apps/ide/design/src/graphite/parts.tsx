import { useEffect } from 'react'
import {
  AlertTriangle, Bell, Check, ChevronDown, GitBranch, LayoutGrid, Link2, MessageSquare, PanelBottom, PanelLeft, PanelRight,
  Plus, Radio, Search, UserPlus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut,
} from '@/components/ui/command'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agents, members, room, statusLabel, vendorName, type Agent } from '@/data/room'
import { ShaderOrb } from '@/gpu/components'
import { FileIcon } from '@/shared/CodeView'
import { cn } from '@/lib/utils'

export const gc = (a: Agent) => a.color.graphite

export function AgentDot({ agent, size = 14, className }: { agent: Agent; size?: number; className?: string }) {
  return <ShaderOrb color={gc(agent)} status={agent.status} size={size} seed={agents.indexOf(agent) + 1} className={className} />
}

export function StatusText({ agent, className }: { agent: Agent; className?: string }) {
  const busy = agent.status === 'editing' || agent.status === 'running' || agent.status === 'thinking'
  const warn = agent.status === 'blocked' || agent.status === 'waiting_review'
  return (
    <span className={cn('truncate', busy && 'shimmer', warn && 'text-warn', !busy && !warn && 'text-muted-foreground', className)}>
      {agent.doing}
    </span>
  )
}

function IconBtn({ label, children, onClick, active }: { label: string; children: React.ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}
          className={cn('text-muted-foreground hover:text-foreground', active && 'text-foreground')}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Person({ id }: { id: string }) {
  const m = members.find(x => x.id === id)!
  const mine = agents.filter(a => a.owner === id)
  return (
    <HoverCard openDelay={80} closeDelay={60}>
      <HoverCardTrigger asChild>
        <button className="relative -ml-1.5 first:ml-0 rounded-full ring-2 ring-frame transition-transform hover:z-10 hover:-translate-y-px">
          <span className="grid size-6 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-foreground/90"
            style={{ boxShadow: `inset 0 0 0 1.5px ${gc(mine[0])}` }}>{m.initials}</span>
          <span className="absolute -right-0.5 -bottom-0.5 grid size-3.5 place-items-center rounded-full bg-primary text-[8.5px] font-bold text-primary-foreground ring-2 ring-frame">{mine.length}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">{m.name}{m.you && <span className="text-muted-foreground"> (this device)</span>}</span>
          <span className="text-xs text-muted-foreground">{mine.length} agents</span>
        </div>
        <div className="grid gap-0.5 p-1.5">
          {mine.map(a => (
            <div key={a.id} className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5">
              <AgentDot agent={a} size={16} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{a.name}</span>
                <StatusText agent={a} className="block text-xs" />
              </span>
            </div>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

export function TitleBar({ onPalette, onInvite, panelOpen = true, onTogglePanel, onRoom }: {
  onPalette: () => void; onInvite: () => void; panelOpen?: boolean; onTogglePanel?: () => void; onRoom?: () => void
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 px-3 select-none">
      <div className="flex items-center gap-2 pr-2">
        {['#ff5f57', '#febc2e', '#28c840'].map(c => <span key={c} className="size-3 rounded-full" style={{ background: c }} />)}
      </div>
      <IconBtn label="Toggle sidebar"><PanelLeft /></IconBtn>
      <button className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium hover:bg-accent">
        <span className="grid size-4 place-items-center rounded bg-primary text-[9px] font-bold text-primary-foreground">H</span>
        {room.name}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </button>
      <span className="flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px] text-muted-foreground">
        <GitBranch className="size-3" /> mp/you/auth-refactor
      </span>

      <div className="flex flex-1 justify-center">
        <button onClick={onPalette}
          className="flex h-7 w-full max-w-[440px] items-center gap-2 rounded-lg border bg-raised px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:border-ring/40 hover:text-foreground">
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search files, agents, commands</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center">
          {members.map(m => <Person key={m.id} id={m.id} />)}
        </div>
        <Button size="sm" variant="secondary" onClick={onInvite} className="h-7"><UserPlus /> Invite</Button>
        <div className="flex items-center">
          {onRoom && <IconBtn label="Open the room" onClick={onRoom}><LayoutGrid /></IconBtn>}
          <IconBtn label="Toggle panel"><PanelBottom /></IconBtn>
          <IconBtn label="Toggle agents" active={panelOpen} onClick={onTogglePanel}><PanelRight /></IconBtn>
        </div>
      </div>
    </header>
  )
}

export function StatusBar() {
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 px-3 text-[11.5px] text-muted-foreground select-none">
      <span className="flex items-center gap-1"><GitBranch className="size-3" /> mp/you/auth-refactor</span>
      <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" /> Room live · {room.relay}</span>
      <span className="flex items-center gap-1"><Radio className="size-3" /> {room.totals.agents} agents · {room.totals.people} people</span>
      <span className="flex items-center gap-1 text-warn"><AlertTriangle className="size-3" /> 1 conflict</span>
      <span className="flex-1" />
      <span>Ln 14, Col 37</span>
      <span>Spaces: 2</span>
      <span>TypeScript</span>
      <Bell className="size-3" />
    </footer>
  )
}

export function CommandPalette({ open, onOpenChange, onAgent, onFile, onNewAgent, onRoom }: {
  open: boolean; onOpenChange: (o: boolean) => void
  onAgent: (id: string) => void; onFile: (path: string) => void; onNewAgent: () => void; onRoom?: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onOpenChange(!open) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  const run = (fn: () => void) => () => { fn(); onOpenChange(false) }
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} className="sm:max-w-[560px]">
      <Command>
        <CommandInput placeholder="Search files, agents, commands…" />
        <CommandList className="max-h-[380px]">
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Agents">
            {agents.map(a => (
              <CommandItem key={a.id} value={`agent ${a.name} ${a.task}`} onSelect={run(() => onAgent(a.id))}>
                <AgentDot agent={a} size={14} />
                <span className="font-medium">{a.name}</span>
                <span className="truncate text-muted-foreground">{statusLabel[a.status]} · {vendorName(a.vendor)} · {members.find(m => m.id === a.owner)!.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Room">
            <CommandItem onSelect={run(onNewAgent)}><Plus /> New agent…<CommandShortcut>⌘⇧N</CommandShortcut></CommandItem>
            <CommandItem onSelect={run(() => onAgent('room'))}><MessageSquare /> Message the room<CommandShortcut>⌘⇧M</CommandShortcut></CommandItem>
            <CommandItem onSelect={run(() => (onRoom ? onRoom() : onAgent('room')))}><LayoutGrid /> What is everyone doing?</CommandItem>
            <CommandItem onSelect={run(() => {})}><Check /> Review `prisma migrate deploy`</CommandItem>
            <CommandItem onSelect={run(() => {})}><Link2 /> Copy invite link</CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Files">
            {['src/auth/middleware.ts', 'src/auth/session.ts', 'test/api/rooms.test.ts'].map(p => (
              <CommandItem key={p} value={`file ${p}`} onSelect={run(() => onFile(p))}>
                <FileIcon name={p} /> {p.split('/').pop()} <span className="text-muted-foreground">{p}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
