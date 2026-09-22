import { useRef } from 'react'
import { Check, Circle, CircleDot, FolderGit2, MessageSquare, Pause, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { agentById, agents, memberById, streams, vendorName, type Agent, type StreamEvent } from '@/data/room'
import { useStaggerIn } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { Micro, Orb, pc } from './parts'

export function Inspector({ agentId }: { agentId: string }) {
  const a = agentById(agentId)
  const owner = memberById(a.owner)
  const ref = useRef<HTMLDivElement>(null)
  useStaggerIn(ref, '[data-in]', [agentId], { step: 40, y: 8 })
  return (
    <aside ref={ref} className="flex h-full flex-col">
      <div className="relative shrink-0 overflow-hidden border-b border-hairline px-5 pt-5 pb-4">
        <div className="pointer-events-none absolute -top-16 -right-10 size-56 rounded-full opacity-25 blur-3xl" style={{ background: pc(a) }} />
        <div data-in className="flex items-start gap-4">
          <Orb agent={a} size={56} />
          <div className="min-w-0 pt-1">
            <h2 className="font-serif text-[32px] leading-none tracking-tight">{a.name}</h2>
            <Micro className="mt-2 block text-muted-foreground">{vendorName(a.vendor)} · {owner.name}</Micro>
          </div>
        </div>
        <p data-in className={cn('mt-4 text-[13px]', a.status === 'blocked' || a.status === 'waiting_review' ? 'text-warn' : 'shimmer')}>{a.doing}</p>
        <Micro className="mt-1.5 flex items-center gap-1.5 text-faint"><FolderGit2 className="size-3" /> {a.branch}</Micro>
        <div data-in className="mt-4 flex gap-1.5">
          <Button size="sm" className="h-7 rounded-full px-3"><MessageSquare /> Message</Button>
          <Button size="sm" variant="outline" className="h-7 rounded-full border-white/12 bg-transparent px-3"><Pause /> Pause</Button>
          <Button size="sm" variant="outline" className="h-7 rounded-full border-white/12 bg-transparent px-3"><SquareTerminal /> Terminal</Button>
        </div>
      </div>

      <Tabs defaultValue="stream" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="h-10 w-full shrink-0 justify-start gap-4 rounded-none border-b border-hairline px-5">
          {['stream', 'plan', 'diff'].map(t => (
            <TabsTrigger key={t} value={t} className="flex-none px-0 font-mono text-[10.5px] tracking-[0.08em] uppercase">{t}</TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="stream" className="min-h-0 overflow-auto px-5 py-3">
          <Stream a={a} />
        </TabsContent>
        <TabsContent value="plan" className="min-h-0 overflow-auto px-5 py-4">
          <Micro className="text-muted-foreground">{a.plan.title}</Micro>
          <ol className="mt-3 grid gap-2.5">
            {a.plan.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-3 text-[13px]">
                <span className="w-5 font-mono text-[11px] text-faint">{String(i + 1).padStart(2, '0')}</span>
                {s.state === 'done' ? <Check className="size-3.5 text-ok" /> : s.state === 'active' ? <CircleDot className="size-3.5" style={{ color: pc(a) }} /> : <Circle className="size-3.5 text-faint" />}
                <span className={cn(s.state === 'todo' && 'text-muted-foreground', s.state === 'done' && 'text-muted-foreground')}>{s.title}</span>
              </li>
            ))}
          </ol>
        </TabsContent>
        <TabsContent value="diff" className="min-h-0 overflow-auto px-5 py-4">
          <div className="grid gap-2">
            {a.files.map(f => (
              <div key={f.path} className="flex items-center gap-2 rounded-md border border-hairline px-3 py-2 font-mono text-[11.5px]">
                <span className="truncate">{f.path}</span>
                <span className="ml-auto text-ok">+{f.additions}</span><span className="text-danger">−{f.deletions}</span>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </aside>
  )
}

const KIND: Record<StreamEvent['kind'], string> = { prompt: 'PROMPT', say: 'SAYS', tool: '', coord: 'ROOM', inbox: 'INBOX' }

function Stream({ a }: { a: Agent }) {
  return (
    <div className="grid gap-3">
      {(streams[a.id] ?? []).map((e, i) => {
        const label = e.kind === 'tool' ? e.tool.toUpperCase() : KIND[e.kind]
        return (
          <div key={i} data-in className="grid grid-cols-[38px_58px_1fr] items-baseline gap-2">
            <span className="font-mono text-[10.5px] text-faint">{e.at}</span>
            <Micro style={{ color: e.kind === 'tool' || e.kind === 'coord' ? pc(a) : undefined }} className={cn(e.kind === 'inbox' && 'text-warn', (e.kind === 'say' || e.kind === 'prompt') && 'text-muted-foreground')}>{label}</Micro>
            {e.kind === 'tool' ? (
              <span className="min-w-0 font-mono text-[12px] break-all text-foreground/85">
                {e.target}{' '}
                {e.detail && <span className={cn(e.ok === false ? 'text-warn' : 'text-muted-foreground')}>{e.detail}</span>}
                {e.live && <span className="blink ml-1 inline-block h-3 w-1.5 translate-y-0.5" style={{ background: pc(a) }} />}
              </span>
            ) : e.kind === 'inbox' ? (
              <span className="text-[13px] leading-relaxed">
                <span className="text-muted-foreground">from </span>
                <span style={{ color: agents.find(x => x.id === e.from) ? pc(agentById(e.from)) : undefined }}>{agents.find(x => x.id === e.from)?.name ?? memberById(e.from).name}</span>
                <span className="text-muted-foreground">: </span>{e.text}
              </span>
            ) : (
              <span className={cn('text-[13px] leading-relaxed', e.kind === 'prompt' && 'font-serif text-[16px] italic', e.kind === 'coord' && 'text-muted-foreground')}>{e.text}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
