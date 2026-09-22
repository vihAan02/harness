import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate, stagger, svg } from 'animejs'
import { AlertTriangle, Snowflake } from 'lucide-react'
import { agents, describeConflict, memberById, room, vendorName } from '@/data/room'
import { PrismField } from '@/gpu/components'
import { reducedMotion, useCountUp, useStaggerIn } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { Micro, Orb, pc, PlanBar, statusMicro } from './parts'

// Room map layout, in 0..1 of the canvas.
const DIRS: Record<string, { x: number; y: number; frozen?: boolean }> = {
  'test/api': { x: 0.09, y: 0.9 },
  'src/limits': { x: 0.33, y: 0.92 },
  'src/auth': { x: 0.5, y: 0.4 },
  prisma: { x: 0.72, y: 0.2, frozen: true },
  'src/db': { x: 0.93, y: 0.62 },
  'web/billing': { x: 0.78, y: 0.9 },
}
const AGENT_AT: Record<string, { x: number; y: number }> = {
  'api-tests': { x: 0.12, y: 0.6 },
  'rate-limit': { x: 0.31, y: 0.66 },
  'auth-refactor': { x: 0.52, y: 0.66 },
  'billing-ui': { x: 0.68, y: 0.74 },
  'migrate-db': { x: 0.85, y: 0.4 },
}
// agent ↔ agent traffic: [from, to, kind]
const TRAFFIC: [string, string, 'message' | 'conflict' | 'review'][] = [
  ['rate-limit', 'auth-refactor', 'conflict'],
  ['auth-refactor', 'rate-limit', 'message'],
  ['migrate-db', 'auth-refactor', 'review'],
]

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

const curve = (a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.18) => {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const dx = b.x - a.x, dy = b.y - a.y
  return `M${a.x},${a.y} Q${mx - dy * bend},${my + dx * bend} ${b.x},${b.y}`
}

function RoomMap({ focus, onFocus }: { focus: string; onFocus: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const { w, h } = useSize(box)
  const P = (p: { x: number; y: number }) => ({ x: p.x * w, y: p.y * h })

  // draw edges in, then keep packets flowing along the message routes
  useEffect(() => {
    const root = svgRef.current
    if (!root || !w || reducedMotion()) return
    const anims: { revert: () => void }[] = []
    anims.push(animate(svg.createDrawable(root.querySelectorAll('.edge')), {
      draw: ['0 0', '0 1'], duration: 1100, delay: stagger(70, { start: 250 }), ease: 'inOutQuart',
    }))
    root.querySelectorAll<SVGPathElement>('.route').forEach((path, i) => {
      const dot = root.querySelector<SVGCircleElement>(`.packet-${i}`)
      if (!dot) return
      anims.push(animate(dot, {
        ...svg.createMotionPath(path), duration: 2400, loop: true, ease: 'inOutSine', delay: 1200 + i * 700,
        opacity: [{ to: 1, duration: 200 }, { to: 1, duration: 2000 }, { to: 0, duration: 200 }],
      }))
    })
    anims.push(animate(root.querySelectorAll('.conflict-ring'), {
      r: [14, 30], opacity: [0.7, 0], duration: 1600, loop: true, ease: 'outQuad',
    }))
    return () => anims.forEach(a => a.revert())
  }, [w, h])

  useStaggerIn(box, '[data-node]', [w > 0], { step: 60, y: 10, duration: 700 })

  const lights = agents.map(a => ({ ...AGENT_AT[a.id], color: pc(a), intensity: a.id === focus ? 1.25 : a.status === 'idle' ? 0.3 : 0.8 }))
  const routes = TRAFFIC.map(([f, t]) => curve(P(AGENT_AT[f]), P(AGENT_AT[t]), 0.35))

  return (
    <div ref={box} className="absolute inset-0">
      <PrismField lights={lights} />
      {/* fine dot grid */}
      <div className="absolute inset-0 opacity-[0.22] [background-image:radial-gradient(rgb(255_255_255/0.35)_0.6px,transparent_0.6px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_85%)]" />
      {w > 0 && (
        <svg ref={svgRef} className="absolute inset-0" width={w} height={h}>
          {agents.flatMap(a => a.claims.map(c => c.replace('/**', '')).filter(d => DIRS[d]).map(d => (
            <path key={a.id + d} className="edge" d={curve(P(AGENT_AT[a.id]), P(DIRS[d]), 0.08)} fill="none"
              stroke={pc(a)} strokeOpacity={a.id === focus ? 0.8 : 0.35} strokeWidth={a.id === focus ? 1.4 : 1} />
          )))}
          {TRAFFIC.map(([, , kind], i) => (
            <path key={i} className="edge route" d={routes[i]} fill="none"
              stroke={kind === 'conflict' ? 'var(--warn)' : 'white'} strokeOpacity={kind === 'conflict' ? 0.75 : 0.28}
              strokeDasharray={kind === 'message' ? '2 5' : kind === 'review' ? '6 4' : undefined} strokeWidth={kind === 'conflict' ? 1.3 : 1} />
          ))}
          {TRAFFIC.map(([, , kind], i) => (
            <circle key={i} className={`packet-${i}`} r={2.6} opacity={0} fill={kind === 'conflict' ? 'var(--warn)' : 'white'}
              style={{ filter: 'drop-shadow(0 0 4px white)' }} />
          ))}
          {(() => {
            const p = P({ x: (AGENT_AT['rate-limit'].x + AGENT_AT['auth-refactor'].x) / 2, y: 0.55 })
            return <circle className="conflict-ring" cx={p.x} cy={p.y} r={14} fill="none" stroke="var(--warn)" strokeWidth={1} opacity={0} />
          })()}
        </svg>
      )}
      {w > 0 && Object.entries(DIRS).map(([d, pos]) => {
        const p = P(pos)
        const owner = agents.find(a => a.claims.includes(`${d}/**`))
        return (
          <div key={d} data-node className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: p.x, top: p.y }}>
            <div className={cn('flex items-center gap-1.5 rounded-md border bg-black/70 px-2 py-1 backdrop-blur', pos.frozen ? 'border-[#9fd0ff]/40' : 'border-white/12')}>
              {pos.frozen && <Snowflake className="size-3 text-[#9fd0ff]" />}
              <Micro className="text-foreground/85">{d}/</Micro>
              {owner && <span className="size-1.5 rounded-full" style={{ background: pc(owner), boxShadow: `0 0 6px ${pc(owner)}` }} />}
            </div>
            {pos.frozen && <Micro className="absolute top-full left-1/2 mt-1 -translate-x-1/2 whitespace-nowrap text-[#9fd0ff]/80">frozen · review</Micro>}
          </div>
        )
      })}
      {w > 0 && agents.map(a => {
        const p = P(AGENT_AT[a.id])
        const on = focus === a.id
        return (
          <button key={a.id} data-node onClick={() => onFocus(a.id)}
            className="group absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1" style={{ left: p.x, top: p.y }}>
            <Orb agent={a} size={on ? 40 : 30} />
            <span className={cn('rounded px-1 text-[12px] font-medium whitespace-nowrap transition-colors', on ? 'text-foreground' : 'text-foreground/70 group-hover:text-foreground')}>{a.name}</span>
            <span className="-mt-1 whitespace-nowrap">{statusMicro(a)}</span>
          </button>
        )
      })}
    </div>
  )
}

function Board({ focus, onFocus }: { focus: string; onFocus: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useStaggerIn(ref, '[data-row]', [], { step: 50 })
  const cols = 'grid grid-cols-[170px_minmax(0,1.5fr)_140px_minmax(0,1.1fr)_minmax(0,1.2fr)] gap-5'
  return (
    <div ref={ref} className="px-5 pb-24">
      <div className={cn(cols, 'border-b border-hairline py-2.5 text-muted-foreground')}>
        {['Agent', 'Task · claims', 'Plan', 'Files', 'Conflicts'].map(h => <Micro key={h} className="text-faint">{h}</Micro>)}
      </div>
      {agents.map(a => {
        const done = a.plan.steps.filter(s => s.state === 'done').length
        const active = a.plan.steps.find(s => s.state === 'active')
        const on = a.id === focus
        return (
          <button key={a.id} data-row onClick={() => onFocus(a.id)}
            className={cn(cols, 'relative w-full items-start border-b border-hairline py-3 text-left transition-colors', on ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]')}>
            {on && <span className="absolute top-2 bottom-2 left-0 w-px" style={{ background: pc(a), boxShadow: `0 0 8px ${pc(a)}` }} />}
            <span className="flex items-center gap-2.5 pl-1.5">
              <Orb agent={a} size={18} />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{a.name}</span>
                <Micro className="text-faint">{memberById(a.owner).name} · {vendorName(a.vendor)}</Micro>
              </span>
            </span>
            <span className="grid gap-1.5">
              <span className="text-[13px] text-foreground/85">{a.task}</span>
              <span className="flex flex-wrap gap-1">
                {a.claims.map(c => <span key={c} className="rounded border border-white/10 px-1.5 font-mono text-[10.5px] text-foreground/65">{c}</span>)}
              </span>
            </span>
            <span className="grid gap-1.5 pt-1">
              <PlanBar agent={a} />
              <Micro className="truncate text-muted-foreground">{done}/{a.plan.steps.length} · {active?.title}</Micro>
            </span>
            <span className="grid gap-0.5 font-mono text-[11.5px]">
              {a.files.slice(0, 2).map(f => (
                <span key={f.path} className="truncate text-foreground/75">
                  {f.path.split('/').slice(-2).join('/')} <span className="text-ok">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span>
                </span>
              ))}
            </span>
            <span className="grid gap-1 text-[12px]">
              {a.conflicts.length ? a.conflicts.map((c, i) => (
                <span key={i} className={cn('flex gap-1.5', c.kind === 'review' ? 'text-[#9fd0ff]' : 'text-warn')}>
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {describeConflict(c)}
                </span>
              )) : <span className="text-faint">—</span>}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function RoomView({ focus, onFocus }: { focus: string; onFocus: (id: string) => void }) {
  const files = useCountUp(room.totals.files)
  const people = new Set(agents.map(a => a.owner)).size
  return (
    <div className="h-full overflow-auto">
      <section className="relative h-[440px] overflow-hidden border-b border-hairline">
        <RoomMap focus={focus} onFocus={onFocus} />
        <div className="pointer-events-none absolute top-5 left-6">
          <h1 className="font-serif text-[44px] leading-[1.02] tracking-[-0.01em]">What is everyone<br /><em className="text-foreground/80">doing?</em></h1>
          <Micro className="mt-3 block text-muted-foreground">
            {agents.length} agents · {people} people · {files} files · <span className="text-warn">1 conflict</span> · <span className="text-[#9fd0ff]">1 review</span>
          </Micro>
        </div>
        <div className="pointer-events-none absolute top-6 right-6 grid justify-items-end gap-1.5 text-muted-foreground">
          <Micro className="flex items-center gap-2"><span className="h-px w-5 bg-white/50" /> claim</Micro>
          <Micro className="flex items-center gap-2"><span className="w-5 border-t border-dotted border-white/60" /> message</Micro>
          <Micro className="flex items-center gap-2 text-warn"><span className="h-px w-5 bg-warn" /> conflict</Micro>
        </div>
        <div className="pointer-events-none absolute right-6 bottom-4 flex items-center gap-2">
          <span className="size-1.5 animate-pulse rounded-full bg-ok" /><Micro className="text-muted-foreground">live · webgpu</Micro>
        </div>
      </section>
      <Board focus={focus} onFocus={onFocus} />
    </div>
  )
}

