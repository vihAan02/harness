import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { AgentStatus } from '@/data/room'
import { attachShader, hexToRgb } from './runtime'
import { FIELD, ORB } from './shaders'

const ENERGY: Record<AgentStatus, number> = {
  editing: 1, running: 0.85, thinking: 0.65, waiting_review: 0.3, blocked: 0.22, idle: 0.08,
}

function deepen([r, g, b]: [number, number, number], k = 0.28): [number, number, number, number] {
  return [r * k, g * k, b * k, 1]
}

/**
 * An agent's presence orb: a WebGPU shader sphere whose motion and glow follow the agent's
 * status. Falls back to a CSS gradient (also shown while the shader compiles).
 */
export function ShaderOrb({ color, status, size = 20, seed = 0, className }: {
  color: string; status: AgentStatus; size?: number; seed?: number; className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const state = useRef({ status, color })
  state.current = { status, color }

  useEffect(() => {
    let dispose: (() => void) | null = null
    const signal = { cancelled: false }
    const rgb = hexToRgb(color)
    let last = ''
    attachShader(canvas.current!, ORB, {
      p: { time: 0, energy: ENERGY[status], seed, pulse: status === 'thinking' ? 1 : 0, color: [...rgb, 1], deep: deepen(rgb) },
    }, t => {
      const s = state.current
      const key = s.status + s.color
      const base = { time: t }
      if (key === last) return { p: base }
      last = key
      const c = hexToRgb(s.color)
      return { p: { ...base, energy: ENERGY[s.status], pulse: s.status === 'thinking' ? 1 : 0, color: [...c, 1], deep: deepen(c) } }
    }, { signal }).then(d => { if (signal.cancelled) d?.(); else dispose = d })
    return () => { signal.cancelled = true; dispose?.() }
    // the shader reads live status/color through the ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  const pad = size * 0.5
  return (
    <span className={cn('relative inline-block shrink-0', className)} style={{ width: size, height: size }} aria-hidden>
      <span
        className="absolute inset-[4%] rounded-full"
        style={{ background: `radial-gradient(circle at 35% 30%, #fff8 0%, ${color} 38%, ${color}55 70%, transparent 72%)` }}
      />
      <canvas
        ref={canvas}
        className="absolute"
        style={{ left: -pad / 2, top: -pad / 2, width: size + pad, height: size + pad }}
      />
    </span>
  )
}

export interface FieldLight { x: number; y: number; color: string; intensity: number }

/** Prism's room backdrop: one pool of spectral light per agent over pure black. */
export function PrismField({ lights, className }: { lights: FieldLight[]; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef(lights)
  latest.current = lights

  useEffect(() => {
    let dispose: (() => void) | null = null
    const signal = { cancelled: false }
    const el = canvas.current!
    const bag = () => {
      const ls = latest.current
      const out: Record<string, unknown> = {}
      for (let i = 0; i < 5; i++) {
        const l = ls[i]
        out[`l${i}`] = l ? [l.x, l.y, l.intensity, i * 0.37] : [0, 0, 0, 0]
        out[`c${i}`] = l ? [...hexToRgb(l.color), 1] : [0, 0, 0, 1]
      }
      return out
    }
    attachShader(el, FIELD, {
      f: { time: 0, aspect: el.clientWidth / Math.max(1, el.clientHeight), grain: 0.018, pad: 0, ...bag() },
    }, t => ({ f: { time: t, aspect: el.clientWidth / Math.max(1, el.clientHeight), ...bag() } }), { dpr: 1, signal })
      .then(d => { if (signal.cancelled) d?.(); else dispose = d })
    return () => { signal.cancelled = true; dispose?.() }
  }, [])

  return (
    <div className={cn('absolute inset-0 overflow-hidden', className)} aria-hidden>
      {/* fallback while (or if not) WebGPU renders */}
      <div className="absolute inset-0" style={{
        background: lights.map(l => `radial-gradient(circle at ${l.x * 100}% ${l.y * 100}%, ${l.color}33 0%, transparent 28%)`).join(','),
      }} />
      <canvas ref={canvas} className="absolute inset-0 size-full" />
    </div>
  )
}
