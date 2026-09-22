import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, stagger, svg } from 'animejs'
import {
  AlertTriangle, ArrowRight, Check, ChevronDown, ChevronRight, CircleDot, Clock, FlaskConical, Link2, Lock, MessageSquare,
  Plus, Radio, Reply, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  agentById, agents, comms, KIND_LABEL, memberById, partyName, room, threads,
  type Agent, type CommEvent, type CommKind, type Party, type PlanStep, type Thread,
} from '@/data/room'
import { reducedMotion, useStaggerIn } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { AgentDot, gc, StatusText } from './parts'

const ROW_H = 52
const LANES: Party[] = [
  { type: 'agent', id: 'auth-refactor' },
  { type: 'agent', id: 'rate-limit' },
  { type: 'agent', id: 'migrate-db' },
  { type: 'agent', id: 'api-tests' },
  { type: 'agent', id: 'billing-ui' },
  { type: 'member', id: 'maya' },
]
const laneIndex = (p: Party) => LANES.findIndex(l => l.id === p.id)
const partyColor = (p: Party) => (p.type === 'agent' ? gc(agentById(p.id)) : p.type === 'member' ? '#b8b7b1' : 'var(--warn)')

const KIND_CLASS: Record<CommKind, string> = {
  question: 'bg-secondary text-foreground/85',
  answer: 'bg-[#86d49e]/15 text-[#86d49e]',
  review: 'bg-warn/15 text-warn',
  approve: 'bg-[#86d49e]/15 text-[#86d49e]',
  denied: 'bg-danger/15 text-danger',
  handoff: 'bg-primary/15 text-foreground',
  note: 'bg-secondary text-foreground/85',
  claim: 'bg-secondary text-muted-foreground',
  fyi: 'bg-secondary text-muted-foreground',
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return size
}

const pct = (a: Agent) => {
  const done = a.plan.steps.filter(s => s.state === 'done').length
  const active = a.plan.steps.some(s => s.state === 'active') ? 0.5 : 0
  return Math.round(((done + active) / a.plan.steps.length) * 100)
}

/**
 * The Room window: a live picture of who is talking to whom, what each agent planned,
 * and how far along it is. Opens as an editor tab, the way Harness's room home does.
 */
export function RoomWindow({ focus, onFocus, onOpenAgent, onNewAgent }: {
  focus: string
  onFocus: (id: string) => void
  onOpenAgent: (id: string) => void
  onNewAgent: () => void
}) {
  const [thread, setThread] = useState<string | undefined>()
  return (
    <div className="h-full overflow-auto">
      <Header onNewAgent={onNewAgent} />
      <Attention onThread={setThread} onOpenAgent={onOpenAgent} />
      <Conversations thread={thread} onThread={setThread} focus={focus} onFocus={onFocus} onOpenAgent={onOpenAgent} />
      <Plans focus={focus} onFocus={onFocus} onOpenAgent={onOpenAgent} />
    </div>
  )
}

function Section({ title, hint, children, right }: { title: string; hint: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-t border-hairline px-6 py-5">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[13px] font-semibold tracking-wide">{title}</h2>
        <span className="text-[12px] text-muted-foreground">{hint}</span>
        <span className="flex-1" />
        {right}
      </div>
      {children}
    </section>
  )
}

function Header({ onNewAgent }: { onNewAgent: () => void }) {
  const steps = agents.flatMap(a => a.plan.steps)
  const done = steps.filter(s => s.state === 'done').length
  const bar = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!bar.current || reducedMotion()) return
    const a = animate(bar.current.querySelectorAll('[data-seg]'), { scaleX: [0, 1], duration: 900, delay: stagger(60), ease: 'outQuart' })
    return () => { a.revert() }
  }, [])
  return (
    <div className="px-6 pt-5 pb-4">
      <div className="flex items-center gap-3">
        <h1 className="text-[20px] font-semibold">Room</h1>
        <span className="flex h-6 items-center gap-1.5 rounded-md border px-2 text-[12px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ok)]" /> live · {room.name}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" onClick={onNewAgent}><Plus /> New agent</Button>
        <Button size="sm" variant="secondary"><MessageSquare /> Message the room</Button>
        <Button size="sm" variant="ghost" className="text-muted-foreground"><Link2 /> Copy invite</Button>
      </div>

      <div className="mt-4 flex items-center gap-4">
        <div ref={bar} className="flex h-2 flex-1 gap-0.5 overflow-hidden rounded-full bg-muted">
          {agents.map(a => (
            <div key={a.id} data-seg className="h-full origin-left rounded-full" style={{ width: `${(pct(a) / agents.length)}%`, background: gc(a) }} />
          ))}
        </div>
        <span className="text-[12.5px] text-muted-foreground">
          <b className="font-medium text-foreground">{done} of {steps.length}</b> plan steps done
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-4 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><Radio className="size-3.5" /> {agents.length} agents · 3 people</span>
        <span className="flex items-center gap-1.5"><MessageSquare className="size-3.5" /> {threads.length} threads, 2 need an answer</span>
        <span className="flex items-center gap-1.5 text-warn"><AlertTriangle className="size-3.5" /> 1 conflict · 2 agents blocked</span>
        <span className="flex items-center gap-1.5"><Clock className="size-3.5" /> oldest agent running 36m</span>
      </div>
    </div>
  )
}

function Attention({ onThread, onOpenAgent }: { onThread: (t: string) => void; onOpenAgent: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useStaggerIn(ref, '[data-card]', [], { step: 60 })
  const cards = [
    {
      tone: 'warn' as const, title: 'Waiting on you', icon: <Lock className="size-3.5" />,
      body: <><b className="font-medium">migrate-db</b> needs <code className="font-mono text-[11.5px]">prisma migrate deploy</code> approved. prisma/** is frozen for everyone.</>,
      actions: <><Button size="xs"><Check /> Approve</Button><Button size="xs" variant="secondary" onClick={() => onThread('t1')}>Open thread</Button><Button size="xs" variant="ghost"><X /> Deny</Button></>,
    },
    {
      tone: 'warn' as const, title: 'Blocked', icon: <AlertTriangle className="size-3.5" />,
      body: <><b className="font-medium">rate-limit</b> can’t edit middleware.ts — it’s in auth-refactor’s claim. They agreed on a handoff.</>,
      actions: <><Button size="xs" variant="secondary" onClick={() => onThread('t2')}>Open thread</Button><Button size="xs" variant="ghost" onClick={() => onOpenAgent('rate-limit')}>Watch agent</Button></>,
    },
    {
      tone: 'plain' as const, title: 'Unanswered', icon: <FlaskConical className="size-3.5" />,
      body: <><b className="font-medium">api-tests</b> asked the room which status code /v1/rooms/join should return. 17 minutes, no reply.</>,
      actions: <><Button size="xs" variant="secondary" onClick={() => onThread('t4')}>Open thread</Button><Button size="xs" variant="ghost">Assign to an agent</Button></>,
    },
  ]
  return (
    <div ref={ref} className="grid grid-cols-3 gap-3 px-6 pb-5">
      {cards.map(c => (
        <div data-card key={c.title} className={cn('grid content-start gap-2 rounded-xl border p-3', c.tone === 'warn' ? 'border-warn/25 bg-warn/[0.04]' : 'border-hairline bg-raised/50')}>
          <span className={cn('flex items-center gap-1.5 text-[11px] font-semibold tracking-wide', c.tone === 'warn' ? 'text-warn' : 'text-muted-foreground')}>
            {c.icon} {c.title.toUpperCase()}
          </span>
          <p className="text-[12.5px] leading-relaxed text-foreground/85">{c.body}</p>
          <div className="flex gap-1.5">{c.actions}</div>
        </div>
      ))}
    </div>
  )
}

// ── conversations ───────────────────────────────────────────────────────────

function Conversations({ thread, onThread, focus, onFocus, onOpenAgent }: {
  thread?: string; onThread: (t?: string) => void; focus: string; onFocus: (id: string) => void; onOpenAgent: (id: string) => void
}) {
  return (
    <Section title="How agents are talking" hint="every message between agents, people and the claim policy"
      right={thread ? <Button size="xs" variant="ghost" onClick={() => onThread(undefined)}><X /> Clear filter</Button> : undefined}>
      <div className="flex gap-4">
        <ThreadList thread={thread} onThread={onThread} />
        <Flow thread={thread} focus={focus} onFocus={onFocus} onOpenAgent={onOpenAgent} />
      </div>
    </Section>
  )
}

const THREAD_STATUS: Record<Thread['status'], { label: string; cls: string }> = {
  waiting_human: { label: 'waiting on a person', cls: 'bg-warn/15 text-warn' },
  waiting_agent: { label: 'waiting on an agent', cls: 'bg-secondary text-foreground/80' },
  agreed: { label: 'agreed', cls: 'bg-[#86d49e]/15 text-[#86d49e]' },
  unanswered: { label: 'unanswered', cls: 'bg-danger/12 text-danger' },
}

function ThreadList({ thread, onThread }: { thread?: string; onThread: (t?: string) => void }) {
  return (
    <div className="w-[292px] shrink-0 space-y-1.5">
      {threads.map(t => {
        const msgs = comms.filter(c => c.thread === t.id)
        const who = [...new Set(msgs.map(m => m.from.id))]
        const on = thread === t.id
        return (
          <div key={t.id} className={cn('rounded-lg border transition-colors', on ? 'border-ring/40 bg-accent' : 'border-hairline hover:bg-accent/50')}>
            <button onClick={() => onThread(on ? undefined : t.id)} className="w-full p-2.5 text-left">
              <div className="flex items-center gap-1.5">
                <span className="flex -space-x-1">
                  {who.map(id => agents.find(a => a.id === id)
                    ? <AgentDot key={id} agent={agentById(id)} size={13} />
                    : <span key={id} className="grid size-3.5 place-items-center rounded-full bg-secondary text-[7px] font-bold">
                        {id === 'harness' ? 'H' : memberById(id).initials}
                      </span>)}
                </span>
                <span className="ml-auto text-[10.5px] text-faint">{msgs.length} msg</span>
                {on ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-faint" />}
              </div>
              <div className="mt-1.5 text-[12.5px] leading-snug font-medium">{t.topic}</div>
              <div className="mt-1 font-mono text-[10.5px] text-muted-foreground">{t.about}</div>
              <div className="mt-2 flex items-center gap-1.5">
                <span className={cn('rounded px-1.5 py-px text-[10px] font-semibold', THREAD_STATUS[t.status].cls)}>{THREAD_STATUS[t.status].label}</span>
              </div>
              <div className="mt-1.5 flex items-start gap-1 text-[11.5px] text-muted-foreground">
                <ArrowRight className="mt-0.5 size-3 shrink-0" /> {t.next}
              </div>
            </button>
            {on && (
              <div className="grid gap-2.5 border-t border-hairline px-2.5 py-2.5">
                {msgs.map(m => (
                  <div key={m.id} className="grid gap-1">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="font-medium" style={{ color: partyColor(m.from) }}>{partyName(m.from)}</span>
                      <ArrowRight className="size-3 text-faint" />
                      <span className="text-muted-foreground">{m.to.length ? m.to.map(partyName).join(', ') : 'the room'}</span>
                      <span className="ml-auto text-[10.5px] text-faint">{m.at}</span>
                    </div>
                    <p className={cn('rounded-md border-l-2 bg-background/40 py-1 pl-2 text-[12px] leading-relaxed text-foreground/85', m.pending && 'opacity-70')}
                      style={{ borderColor: partyColor(m.from) }}>
                      {m.body}
                      {m.pending && <span className="ml-1 text-[10.5px] text-muted-foreground">· in flight</span>}
                    </p>
                  </div>
                ))}
                <div className="flex gap-1.5">
                  <Button size="xs" variant="secondary"><Reply /> Reply in thread</Button>
                  {t.status === 'waiting_human' && <Button size="xs"><Check /> Approve</Button>}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Flow({ thread, focus, onFocus, onOpenAgent }: { thread?: string; focus: string; onFocus: (id: string) => void; onOpenAgent: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const { w } = useSize(box)
  const laneW = w / LANES.length
  const laneX = (i: number) => (i + 0.5) * laneW
  const height = comms.length * ROW_H + 12

  useEffect(() => {
    const root = svgRef.current
    if (!root || !w || reducedMotion()) return
    const anims: { revert: () => void }[] = []
    anims.push(animate(svg.createDrawable(root.querySelectorAll('.wire')), {
      draw: ['0 0', '0 1'], duration: 420, delay: stagger(55, { start: 150 }), ease: 'outQuad',
    }))
    const live = root.querySelector<SVGPathElement>('.wire-pending')
    const dot = root.querySelector<SVGCircleElement>('.pending-dot')
    if (live && dot) {
      anims.push(animate(dot, { ...svg.createMotionPath(live), duration: 1500, loop: true, ease: 'inOutSine', delay: 900 }))
    }
    return () => anims.forEach(a => a.revert())
  }, [w, thread])

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex" style={{ paddingLeft: 46 }}>
        <div ref={box} className="flex flex-1">
          {LANES.map(p => {
            const a = p.type === 'agent' ? agentById(p.id) : undefined
            const on = a?.id === focus
            return (
              <button key={p.id} onClick={() => a && (onFocus(a.id), onOpenAgent(a.id))} style={{ width: laneW }}
                className={cn('grid justify-items-center gap-1 rounded-md py-1.5 transition-colors', a && 'hover:bg-accent/50', on && 'bg-accent/70')}>
                {a ? <AgentDot agent={a} size={18} /> : (
                  <span className="grid size-[18px] place-items-center rounded-full bg-secondary text-[8px] font-bold">{memberById(p.id).initials}</span>
                )}
                <span className="max-w-full truncate px-1 text-[11.5px] font-medium">{partyName(p)}</span>
                <span className="max-w-full truncate px-1 text-[10px] text-muted-foreground">
                  {a ? (a.status === 'blocked' ? 'blocked' : a.status === 'waiting_review' ? 'waiting' : a.status) : 'person'}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="relative" style={{ height }}>
        <div className="absolute inset-y-0 left-0 w-[46px]">
          {comms.map((c, i) => (
            <span key={c.id} className="absolute right-2 font-mono text-[10.5px] text-faint" style={{ top: i * ROW_H + ROW_H / 2 - 7 }}>{c.at}</span>
          ))}
        </div>
        <div className="absolute inset-y-0 right-0" style={{ left: 46 }}>
          {w > 0 && (
            <svg ref={svgRef} width={w} height={height} className="absolute inset-0 overflow-visible">
              <defs>
                {LANES.map(p => (
                  <marker key={p.id} id={`ah-${p.id}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                    <path d="M0,1 L7,4 L0,7 z" fill={partyColor(p)} />
                  </marker>
                ))}
                <marker id="ah-harness" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,1 L7,4 L0,7 z" fill="var(--danger)" />
                </marker>
              </defs>
              {LANES.map((p, i) => (
                <line key={p.id} x1={laneX(i)} y1={0} x2={laneX(i)} y2={height} stroke={partyColor(p)} strokeOpacity={0.14} strokeWidth={1} />
              ))}
              {comms.map((c, i) => {
                const y = i * ROW_H + ROW_H / 2
                const dim = thread && c.thread !== thread
                const from = laneIndex(c.from)
                const color = partyColor(c.from)
                const op = dim ? 0.12 : 0.85
                if (!c.to.length) {
                  return (
                    <g key={c.id} opacity={op}>
                      <line className="wire" x1={0} y1={y} x2={w} y2={y} stroke={color} strokeOpacity={0.45} strokeWidth={1} strokeDasharray="3 4" />
                      {LANES.map((_, li) => <circle key={li} cx={laneX(li)} cy={y} r={2.5} fill={color} opacity={li === from ? 1 : 0.4} />)}
                    </g>
                  )
                }
                const to = laneIndex(c.to[0])
                const x1 = laneX(from >= 0 ? from : to), x2 = laneX(to)
                const self = from === to || from < 0
                const markerId = c.from.type === 'harness' ? 'ah-harness' : `ah-${c.from.id}`
                return (
                  <g key={c.id} opacity={op}>
                    {self ? (
                      <path className={cn('wire', c.pending && 'wire-pending')} d={`M${x2 - 26},${y - 9} h20 a8,8 0 0 1 0,18 h-20`} fill="none"
                        stroke={c.from.type === 'harness' ? 'var(--danger)' : color} strokeWidth={1.3} markerEnd={`url(#${markerId})`} />
                    ) : (
                      <path className={cn('wire', c.pending && 'wire-pending')} d={`M${x1},${y} L${x2 - (x2 > x1 ? 7 : -7)},${y}`} fill="none"
                        stroke={color} strokeWidth={c.pending ? 1.6 : 1.3} strokeDasharray={c.pending ? '4 4' : undefined} markerEnd={`url(#${markerId})`} />
                    )}
                    <circle cx={x1} cy={y} r={3} fill={color} />
                  </g>
                )
              })}
              <circle className="pending-dot" r={3} fill="var(--foreground)" opacity={comms.some(c => c.pending) ? 1 : 0} />
            </svg>
          )}

          {w > 0 && comms.map((c, i) => {
            const from = laneIndex(c.from)
            const to = c.to.length ? laneIndex(c.to[0]) : -1
            const x = c.to.length
              ? (from >= 0 ? (laneX(from) + laneX(to)) / 2 : laneX(to) - 40)
              : laneX(from >= 0 ? from : 0)
            const dim = thread && c.thread !== thread
            return (
              <Bubble key={c.id} c={c} x={x} y={i * ROW_H + ROW_H / 2} dim={!!dim} onOpenAgent={onOpenAgent} />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Bubble({ c, x, y, dim, onOpenAgent }: { c: CommEvent; x: number; y: number; dim: boolean; onOpenAgent: (id: string) => void }) {
  const to = c.to.length ? c.to.map(partyName).join(', ') : 'the room'
  return (
    <HoverCard openDelay={60} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          className={cn('absolute flex max-w-[330px] -translate-x-1/2 items-center gap-1.5 rounded-md border border-hairline bg-panel/95 px-1.5 py-1 text-left backdrop-blur transition-opacity hover:border-ring/40',
            dim && 'opacity-25')}
          style={{ left: x, top: y - 26 }}>
          <span className={cn('shrink-0 rounded px-1 text-[9.5px] font-bold tracking-wide', KIND_CLASS[c.kind])}>{KIND_LABEL[c.kind]}</span>
          <span className="truncate text-[11.5px] text-foreground/80">{c.body}</span>
          {c.pending && <span className="shrink-0 text-[9.5px] text-muted-foreground">in flight</span>}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-[380px]">
        <div className="flex items-center gap-2 text-[12px]">
          <span className={cn('rounded px-1.5 py-px text-[10px] font-bold', KIND_CLASS[c.kind])}>{KIND_LABEL[c.kind]}</span>
          <span className="font-medium">{partyName(c.from)}</span>
          <ArrowRight className="size-3 text-muted-foreground" />
          <span className="text-muted-foreground">{to}</span>
          <span className="ml-auto text-[11px] text-faint">{c.at}</span>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed">{c.body}</p>
        <div className="mt-3 flex gap-1.5">
          <Button size="xs" variant="secondary"><Reply /> Reply</Button>
          {c.from.type === 'agent' && <Button size="xs" variant="ghost" onClick={() => onOpenAgent(c.from.id)}>Watch {partyName(c.from)}</Button>}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

// ── plans & progress ────────────────────────────────────────────────────────

function Plans({ focus, onFocus, onOpenAgent }: { focus: string; onFocus: (id: string) => void; onOpenAgent: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const { w } = useSize(box)
  const [links, setLinks] = useState<{ d: string; color: string; key: string; agents: [string, string] }[]>([])

  useLayoutEffect(() => {
    const root = box.current
    if (!root) return
    const measure = () => {
      const base = root.getBoundingClientRect()
      const out: { d: string; color: string; key: string; agents: [string, string] }[] = []
      for (const a of agents) {
        a.plan.steps.forEach((s, i) => {
          if (!s.waitsOn) return
          const target = nodes.current.get(`${a.id}:${i}`)
          const source = nodes.current.get(`${s.waitsOn.agent}:${s.waitsOn.step}`)
          if (!target || !source) return
          const sr = source.getBoundingClientRect(), tr = target.getBoundingClientRect()
          const x1 = sr.left - base.left + sr.width / 2, y1 = sr.top - base.top + sr.height / 2
          const x2 = tr.left - base.left + tr.width / 2, y2 = tr.top - base.top + tr.height / 2
          const bend = Math.min(60, Math.abs(y2 - y1) * 0.5)
          out.push({
            key: `${a.id}:${i}`, color: gc(agentById(s.waitsOn.agent)), agents: [s.waitsOn.agent, a.id],
            d: `M${x1},${y1 + (y2 > y1 ? 11 : -11)} C${x1},${y1 + (y2 > y1 ? bend : -bend)} ${x2},${y2 - (y2 > y1 ? bend : -bend)} ${x2},${y2 - (y2 > y1 ? 13 : -13)}`,
          })
        })
      }
      setLinks(out)
    }
    const id = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(id)
  }, [w])

  useEffect(() => {
    if (!box.current || reducedMotion() || !links.length) return
    const a = animate(svg.createDrawable(box.current.querySelectorAll('.dep')), { draw: ['0 0', '0 1'], duration: 700, delay: stagger(90, { start: 200 }), ease: 'outQuad' })
    return () => { a.revert() }
  }, [links])

  return (
    <Section title="Plans and progress" hint="each agent's own plan, and where one plan is waiting on another"
      right={<span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground"><span className="h-px w-4 border-t border-dashed border-muted-foreground" /> waits on</span>}>
      <div ref={box} className="relative">
        <svg className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible">
          <defs>
            {agents.map(a => (
              <marker key={a.id} id={`dep-${a.id}`} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M0,1 L7,4 L0,7 z" fill={gc(a)} />
              </marker>
            ))}
          </defs>
          {links.map(l => {
            const lit = l.agents.includes(focus)
            return (
              <path key={l.key} className="dep" d={l.d} fill="none" stroke={l.color} strokeOpacity={lit ? 0.85 : 0.3}
                strokeWidth={lit ? 1.5 : 1.1} strokeDasharray="3 3" markerEnd={`url(#dep-${l.agents[0]})`} />
            )
          })}
        </svg>
        <div className="grid gap-1">
          {agents.map(a => (
            <PlanRow key={a.id} a={a} on={a.id === focus} onFocus={onFocus} onOpenAgent={onOpenAgent}
              register={(k, el) => { if (el) nodes.current.set(k, el); else nodes.current.delete(k) }} />
          ))}
        </div>
      </div>
    </Section>
  )
}

function PlanRow({ a, on, onFocus, onOpenAgent, register }: {
  a: Agent; on: boolean; onFocus: (id: string) => void; onOpenAgent: (id: string) => void
  register: (key: string, el: HTMLElement | null) => void
}) {
  const p = pct(a)
  const done = a.plan.steps.filter(s => s.state === 'done').length
  return (
    <div onClick={() => onFocus(a.id)}
      className={cn('grid grid-cols-[212px_minmax(0,1fr)_186px] items-center gap-4 rounded-xl border px-3 py-3 transition-colors',
        on ? 'border-ring/30 bg-accent/40' : 'border-transparent hover:bg-accent/25')}>
      <button onClick={() => onOpenAgent(a.id)} className="flex min-w-0 items-center gap-2.5 text-left">
        <AgentDot agent={a} size={22} />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">{a.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{memberById(a.owner).name} · {a.plan.title}</span>
        </span>
      </button>

      <div className="flex min-w-0 items-start">
        {a.plan.steps.map((s, i) => (
          <div key={i} className="flex min-w-0 flex-1 items-start">
            <Step s={s} a={a} i={i} register={register} />
            {i < a.plan.steps.length - 1 && (
              <span className="mt-[10px] h-px min-w-2 flex-1" style={{ background: s.state === 'done' ? `${gc(a)}66` : 'var(--border)' }} />
            )}
          </div>
        ))}
      </div>

      <div className="grid gap-1.5 justify-self-end text-right">
        <div className="flex items-baseline justify-end gap-1.5">
          <span className="text-[15px] font-semibold tabular-nums">{p}%</span>
          <span className="text-[11px] text-muted-foreground">{done}/{a.plan.steps.length} steps</span>
        </div>
        <div className="h-1.5 w-[168px] overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${p}%`, background: gc(a) }} />
        </div>
        <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
          <span>{a.stats.elapsed}</span>
          <span>·</span>
          <span>{a.files.length} files</span>
          <span className="text-[#9fd49a]">+{a.files.reduce((n, f) => n + f.additions, 0)}</span>
          <span className="text-[#ef8f8f]">−{a.files.reduce((n, f) => n + f.deletions, 0)}</span>
          {a.stats.tests && (
            <span className={cn('flex items-center gap-1', a.stats.tests.failed ? 'text-warn' : 'text-[#9fd49a]')}>
              <FlaskConical className="size-3" />{a.stats.tests.passed}{a.stats.tests.failed ? `/${a.stats.tests.failed}✗` : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function Step({ s, a, i, register }: { s: PlanStep; a: Agent; i: number; register: (k: string, el: HTMLElement | null) => void }) {
  const color = gc(a)
  const node = (
    <span ref={el => register(`${a.id}:${i}`, el)}
      className={cn('grid size-[21px] shrink-0 place-items-center rounded-full border text-[10px]',
        s.state === 'done' && 'border-transparent text-[#141413]',
        s.state === 'active' && 'border-transparent',
        s.state === 'todo' && 'border-border text-faint',
        s.state === 'blocked' && 'border-warn/60 text-warn')}
      style={s.state === 'done' ? { background: color } : s.state === 'active' ? { background: `${color}26`, boxShadow: `0 0 0 1.5px ${color}` } : undefined}>
      {s.state === 'done' ? <Check className="size-3" />
        : s.state === 'active' ? <CircleDot className="size-3" style={{ color }} />
        : s.state === 'blocked' ? <Lock className="size-3" />
        : <span className="tabular-nums">{i + 1}</span>}
    </span>
  )
  return (
    <div className="grid min-w-0 justify-items-center gap-1.5" style={{ width: 104 }}>
      {s.waitsOn ? (
        <Tooltip>
          <TooltipTrigger asChild><button>{node}</button></TooltipTrigger>
          <TooltipContent className="max-w-[260px]">
            Waiting on <b>{agentById(s.waitsOn.agent).name}</b> · step {s.waitsOn.step + 1} “{agentById(s.waitsOn.agent).plan.steps[s.waitsOn.step].title}” — {s.waitsOn.why}
          </TooltipContent>
        </Tooltip>
      ) : node}
      <span className={cn('line-clamp-2 px-1 text-center text-[10.5px] leading-tight',
        s.state === 'active' ? 'font-medium text-foreground' : s.state === 'blocked' ? 'text-warn/90' : 'text-muted-foreground')}>
        {s.title}
      </span>
      {s.state === 'active' && <StatusText agent={a} className="max-w-[104px] px-1 text-center text-[10px]" />}
    </div>
  )
}
