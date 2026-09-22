import { useRef, useState } from 'react'
import { AlertTriangle, Blocks, ChevronDown, ChevronRight, Copy, Files, FolderPlus, GitBranch, Lock, Plus, Search, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agents, agentsOnPath, claimOn, lockOn, members, tree, type TreeNode } from '@/data/room'
import { FileIcon } from '@/shared/CodeView'
import { useStaggerIn } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { AgentDot, gc, StatusText } from './parts'

type Tab = 'files' | 'search' | 'git' | 'room' | 'ext'

export function Sidebar({ file, onFile, onAgent, onNewAgent, onRoom }: {
  file: string; onFile: (p: string) => void; onAgent: (id: string) => void; onNewAgent: () => void; onRoom?: () => void
}) {
  const [tab, setTab] = useState<Tab>('files')
  const tabs: { id: Tab; label: string; icon: React.ReactNode; badge?: string; live?: boolean }[] = [
    { id: 'files', label: 'Explorer', icon: <Files /> },
    { id: 'search', label: 'Search', icon: <Search /> },
    { id: 'git', label: 'Source control', icon: <GitBranch />, badge: '6' },
    { id: 'room', label: 'Room', icon: <Users />, live: true },
    { id: 'ext', label: 'Extensions', icon: <Blocks /> },
  ]
  return (
    <aside className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-hairline px-2">
        {tabs.map(t => (
          <Tooltip key={t.id}>
            <TooltipTrigger asChild>
              <button onClick={() => setTab(t.id)} aria-label={t.label}
                className={cn('relative grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-4',
                  tab === t.id && 'bg-accent text-foreground')}>
                {t.icon}
                {t.badge && <span className="absolute -top-0.5 -right-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[8.5px] font-bold text-primary-foreground">{t.badge}</span>}
                {t.live && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      {tab === 'room' ? <RoomTab onAgent={onAgent} onNewAgent={onNewAgent} /> : <FilesTab file={file} onFile={onFile} />}
      <RoomFooter onOpen={onRoom ?? (() => setTab('room'))} />
    </aside>
  )
}

function FilesTab({ file, onFile }: { file: string; onFile: (p: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    prisma: true, src: true, 'src/auth': true, test: true, 'test/api': true, web: false, 'web/billing': true, 'src/limits': false,
  })
  const row = (n: TreeNode, depth: number): React.ReactNode => {
    const isOpen = open[n.path]
    const claim = n.dir ? claimOn(n.path) : undefined
    const touching = n.dir ? [] : agentsOnPath(n.path)
    const lock = n.dir ? undefined : lockOn(n.path)
    const conflict = n.path === 'src/auth/middleware.ts'
    return (
      <div key={n.path}>
        <button
          onClick={() => (n.dir ? setOpen(o => ({ ...o, [n.path]: !o[n.path] })) : onFile(n.path))}
          className={cn('group relative flex h-[22px] w-full items-center gap-1.5 pr-2 text-left text-[13px] hover:bg-accent/60',
            file === n.path && 'bg-accent text-foreground', !n.dir && !touching.length && 'text-foreground/80')}
          style={{ paddingLeft: 8 + depth * 12 }}>
          {claim && <span className="absolute top-0.5 bottom-0.5 left-0.5 w-[2px] rounded-full" style={{ background: gc(claim) }} />}
          {n.dir ? (isOpen ? <ChevronDown className="size-3 text-faint" /> : <ChevronRight className="size-3 text-faint" />) : <span className="w-3" />}
          <FileIcon name={n.name} dir={n.dir} open={isOpen} className={n.dir ? 'text-muted-foreground' : undefined} />
          <span className={cn('truncate', n.git === 'M' && 'text-[#e2c08d]', n.git === 'A' && 'text-[#9fd49a]')}>{n.name}</span>
          <span className="flex-1" />
          {claim && <span className="truncate text-[10.5px] font-medium" style={{ color: gc(claim) }}>{claim.name}</span>}
          {conflict && <AlertTriangle className="size-3 text-warn" />}
          {lock && <Lock className="size-3 text-muted-foreground" />}
          {touching.length > 0 && (
            <span className="flex -space-x-1">{touching.map(a => <AgentDot key={a.id} agent={a} size={11} />)}</span>
          )}
          {n.git && <span className={cn('w-2.5 text-center text-[11px] font-semibold', n.git === 'M' ? 'text-[#e2c08d]' : 'text-[#9fd49a]')}>{n.git}</span>}
        </button>
        {n.dir && isOpen && n.children?.map(c => row(c, depth + 1))}
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between pr-1.5 pl-3">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">MULTIPLAYER-AI</span>
        <span className="flex">
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="New file"><Plus /></Button>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="New folder"><FolderPlus /></Button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">{tree.map(n => row(n, 0))}</div>
    </div>
  )
}

function RoomTab({ onAgent, onNewAgent }: { onAgent: (id: string) => void; onNewAgent: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useStaggerIn(ref, '[data-row]', [])
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto px-2 pb-2">
      <div className="flex h-8 items-center justify-between pl-1">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">WHAT IS EVERYONE DOING?</span>
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onNewAgent} aria-label="New agent"><Plus /></Button>
      </div>
      {members.map(m => (
        <div key={m.id} className="mb-2" data-row>
          <div className="flex items-center gap-2 px-1 py-1 text-xs font-medium text-muted-foreground">
            <span className="grid size-4 place-items-center rounded-full bg-secondary text-[8px] font-bold text-foreground">{m.initials}</span>
            {m.name}
          </div>
          {agents.filter(a => a.owner === m.id).map(a => {
            const done = a.plan.steps.filter(s => s.state === 'done').length
            return (
              <button key={a.id} onClick={() => onAgent(a.id)} data-row
                className="grid w-full gap-1 rounded-lg px-2 py-2 text-left hover:bg-accent/60">
                <span className="flex items-center gap-2">
                  <AgentDot agent={a} size={14} />
                  <span className="text-[13px] font-medium">{a.name}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">{done}/{a.plan.steps.length}</span>
                </span>
                <StatusText agent={a} className="pl-[22px] text-xs" />
                <Progress value={(done / a.plan.steps.length) * 100} className="ml-[22px] h-1 w-auto bg-muted [&>[data-slot=progress-indicator]]:bg-(--progress)" style={{ ['--progress' as string]: gc(a) }} />
                <span className="flex flex-wrap gap-1 pl-[22px]">
                  {a.claims.map(c => <span key={c} className="rounded border px-1 font-mono text-[10.5px] text-muted-foreground">{c}</span>)}
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function RoomFooter({ onOpen }: { onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="m-2 grid gap-2 rounded-lg border border-hairline bg-raised/60 p-2.5 text-left transition-colors hover:bg-raised">
      <span className="flex items-center gap-2 text-xs">
        <span className="size-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" />
        <span className="font-medium">Room is live</span>
        <span className="ml-auto flex items-center gap-1 text-muted-foreground"><Copy className="size-3" /> invite</span>
      </span>
      <span className="flex items-center gap-1.5">
        {agents.map(a => <AgentDot key={a.id} agent={a} size={16} />)}
        <span className="ml-auto flex gap-1">
          <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10.5px] font-medium text-warn">1 conflict</span>
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">1 review</span>
        </span>
      </span>
    </button>
  )
}
