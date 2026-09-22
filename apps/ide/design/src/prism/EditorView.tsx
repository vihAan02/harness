import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, GitCompare, Lock, MessageSquare, Snowflake, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentById, agents, agentsOnPath, claimOn, lockOn, memberById, openFile, tree, type OpenFile, type TreeNode } from '@/data/room'
import { CodeView, FileIcon } from '@/shared/CodeView'
import { cn } from '@/lib/utils'
import { Micro, Orb, pc, PlanBar } from './parts'

const PINNED = ['src/auth/middleware.ts', 'src/auth/session.ts', 'test/api/rooms.test.ts']

export function PrismTree({ file, onFile }: { file: string; onFile: (p: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({ prisma: true, src: true, 'src/auth': true, test: true, 'test/api': true, 'src/limits': true })
  const row = (n: TreeNode, depth: number): React.ReactNode => {
    const claim = n.dir ? claimOn(n.path) : undefined
    const on = n.dir ? [] : agentsOnPath(n.path)
    return (
      <div key={n.path}>
        <button onClick={() => (n.dir ? setOpen(o => ({ ...o, [n.path]: !o[n.path] })) : onFile(n.path))}
          className={cn('relative flex h-6 w-full items-center gap-1.5 pr-3 text-left text-[12.5px] text-foreground/75 hover:bg-white/[0.03] hover:text-foreground',
            file === n.path && 'bg-white/[0.05] text-foreground')}
          style={{ paddingLeft: 12 + depth * 12 }}>
          {n.dir ? (open[n.path] ? <ChevronDown className="size-3 text-faint" /> : <ChevronRight className="size-3 text-faint" />) : <span className="w-3" />}
          <FileIcon name={n.name} dir={n.dir} open={open[n.path]} className={n.dir ? 'text-faint' : 'opacity-80'} />
          <span className="truncate">{n.name}</span>
          <span className="flex-1" />
          {n.path === 'prisma' && <Snowflake className="size-3 text-[#9fd0ff]" />}
          {claim && <span className="h-3 w-0.5 rounded-full" style={{ background: pc(claim), boxShadow: `0 0 6px ${pc(claim)}` }} />}
          {lockOn(n.path) && <Lock className="size-3 text-muted-foreground" />}
          {on.map(a => <span key={a.id} className="size-1.5 rounded-full" style={{ background: pc(a), boxShadow: `0 0 6px ${pc(a)}` }} />)}
        </button>
        {n.dir && open[n.path] && n.children?.map(c => row(c, depth + 1))}
      </div>
    )
  }
  return (
    <aside className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center px-4"><Micro className="text-muted-foreground">Explorer</Micro></div>
      <div className="min-h-0 flex-1 overflow-auto pb-3">{tree.map(n => row(n, 0))}</div>
    </aside>
  )
}

function Ghost({ g, onFocus }: { g: NonNullable<OpenFile['ghost']>; onFocus: (id: string) => void }) {
  const a = agentById(g.agent)
  return (
    <div className="relative my-2 mr-8 ml-[56px] rounded-md border font-sans" style={{ borderColor: `${pc(a)}55`, background: `linear-gradient(90deg, ${pc(a)}10, transparent 70%)` }}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Orb agent={a} size={16} />
        <span className="text-[12.5px] font-medium">{a.name}</span>
        <Micro className="text-muted-foreground">{memberById(a.owner).name} · pending · +4</Micro>
        {g.overlaps && <Micro className="flex items-center gap-1 text-warn"><AlertTriangle className="size-3" /> overlaps {g.overlaps}</Micro>}
        <span className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => onFocus(a.id)}><MessageSquare /> Thread</Button>
        <Button variant="ghost" size="icon-xs" aria-label="Compare"><GitCompare /></Button>
        <Button size="xs" className="rounded-full">Hand off</Button>
      </div>
      <div className="border-t py-1 font-mono text-[12.5px] leading-5" style={{ borderColor: `${pc(a)}30` }}>
        {g.lines.map((l, i) => (
          <div key={i} className={cn('flex px-3 whitespace-pre', l.t === '+' ? 'text-[#8ff0bd]' : 'text-faint')}>
            <span className="w-4 select-none opacity-60">{l.t === ' ' ? '' : l.t}</span>{l.s}
          </div>
        ))}
      </div>
    </div>
  )
}

export function EditorView({ file, onFile, onFocus }: { file: string; onFile: (p: string) => void; onFocus: (id: string) => void }) {
  const f = openFile(file)
  const claimant = agents.find(a => a.claims.some(c => f.path.startsWith(c.replace('/**', '/'))))
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-hairline px-3">
        {(PINNED.includes(file) ? PINNED : [...PINNED, file]).map(p => {
          const on = agentsOnPath(p)
          return (
            <button key={p} onClick={() => onFile(p)}
              className={cn('group flex h-7 items-center gap-2 rounded-full px-3 text-[12.5px] transition-colors',
                p === file ? 'bg-white/[0.07] text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              {p.split('/').pop()}
              {on.map(a => <span key={a.id} className="size-1.5 rounded-full" style={{ background: pc(a), boxShadow: `0 0 6px ${pc(a)}` }} />)}
              <X className="size-3 opacity-0 group-hover:opacity-50" />
            </button>
          )
        })}
      </div>
      {claimant && (
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-hairline px-5">
          <Orb agent={claimant} size={14} />
          <Micro className="text-muted-foreground"><span style={{ color: pc(claimant) }}>{claimant.name}</span> owns {claimant.claims[0]}</Micro>
          <PlanBar agent={claimant} className="w-24" />
          <span className="flex-1" />
          <Micro className="text-faint">{f.path}</Micro>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto pb-24">
        <CodeView file={f} variant="prism" gutter={52}
          renderFlag={(id, color) => (
            <span className="absolute top-0 left-[5px] flex h-[18px] items-center rounded-[3px] border px-1.5 font-mono text-[10px] tracking-[0.06em] whitespace-nowrap uppercase"
              style={{ color, borderColor: `${color}80`, background: '#000', boxShadow: `0 0 14px ${color}55` }}>
              {agentById(id).name}
            </span>
          )}
          renderGhost={g => <Ghost g={g} onFocus={onFocus} />}
        />
      </div>
    </div>
  )
}

export function ReviewView({ onFocus }: { onFocus: (id: string) => void }) {
  const migrate = agentById('migrate-db')
  return (
    <div className="h-full overflow-auto px-8 pt-8 pb-28">
      <h1 className="font-serif text-[40px] leading-none tracking-tight">Review</h1>
      <Micro className="mt-3 block text-muted-foreground">1 gated command · 1 conflict · 9 files across 5 worktrees</Micro>

      <section className="mt-8 rounded-xl border border-[#9fd0ff]/25 bg-[#9fd0ff]/[0.03] p-5">
        <Micro className="text-[#9fd0ff]">Critical command gate</Micro>
        <div className="mt-3 flex items-center gap-3">
          <Orb agent={migrate} size={24} />
          <span className="text-[14px]"><b className="font-medium">{migrate.name}</b> wants to run</span>
          <code className="rounded border border-white/10 bg-black px-2 py-0.5 font-mono text-[12.5px]">prisma migrate deploy</code>
        </div>
        <p className="mt-3 max-w-[640px] text-[13px] leading-relaxed text-muted-foreground">
          It changes shared state (the dev database). <span className="font-mono text-foreground/80">prisma/**</span> is frozen for everyone until this is approved.
          A reviewer agent checked the migration: additive only, no data loss, reversible.
        </p>
        <div className="mt-4 flex gap-2">
          <Button size="sm" className="rounded-full"><Check /> Approve</Button>
          <Button size="sm" variant="outline" className="rounded-full border-white/12 bg-transparent" onClick={() => onFocus(migrate.id)}>Open thread</Button>
          <Button size="sm" variant="ghost" className="rounded-full text-muted-foreground"><X /> Deny</Button>
        </div>
      </section>

      <section className="mt-8">
        <Micro className="text-muted-foreground">Changes by agent</Micro>
        <div className="mt-3 grid gap-2">
          {agents.map(a => (
            <button key={a.id} onClick={() => onFocus(a.id)} className="grid grid-cols-[220px_1fr_auto] items-center gap-6 rounded-lg border border-hairline px-4 py-3 text-left hover:bg-white/[0.02]">
              <span className="flex items-center gap-2.5"><Orb agent={a} size={18} /><span className="text-[13px] font-medium">{a.name}</span></span>
              <span className="grid gap-0.5 font-mono text-[11.5px] text-foreground/75">
                {a.files.map(f => <span key={f.path}>{f.path} <span className="text-ok">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span></span>)}
              </span>
              <Micro className={cn(a.conflicts.some(c => c.kind !== 'review') ? 'text-warn' : 'text-faint')}>
                {a.conflicts.some(c => c.kind !== 'review') ? 'conflict' : 'clean'}
              </Micro>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
