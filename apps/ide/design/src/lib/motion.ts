import { useEffect, useLayoutEffect, useState, type DependencyList, type RefObject } from 'react'
import { animate, stagger } from 'animejs'

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Staggers matching children in (fade + rise) whenever deps change. */
export function useStaggerIn(ref: RefObject<HTMLElement | null>, selector: string, deps: DependencyList, opts: { y?: number; step?: number; duration?: number } = {}) {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || reducedMotion()) return
    const els = root.querySelectorAll(selector)
    if (!els.length) return
    const a = animate(els, {
      opacity: [0, 1],
      translateY: [opts.y ?? 6, 0],
      delay: stagger(opts.step ?? 32),
      duration: opts.duration ?? 460,
      ease: 'outQuart',
    })
    return () => { a.revert() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** Types `text` out character by character, looping, like a live agent cursor. */
export function useTyping(text: string | undefined, speed = 52): string {
  const [n, setN] = useState(text?.length ?? 0)
  useEffect(() => {
    if (!text) return
    if (reducedMotion()) { setN(text.length); return }
    const indent = text.length - text.trimStart().length
    const state = { n: indent }
    const a = animate(state, {
      n: [indent, text.length],
      duration: (text.length - indent) * speed,
      ease: 'linear',
      loop: true,
      loopDelay: 2800,
      onUpdate: () => setN(Math.round(state.n)),
    })
    return () => { a.revert() }
  }, [text, speed])
  return text ? text.slice(0, n) : ''
}

/** Counts a number up on mount. */
export function useCountUp(to: number, duration = 900): number {
  const [v, setV] = useState(reducedMotion() ? to : 0)
  useEffect(() => {
    if (reducedMotion()) return
    const s = { v: 0 }
    const a = animate(s, { v: to, duration, ease: 'outExpo', onUpdate: () => setV(Math.round(s.v)) })
    return () => { a.revert() }
  }, [to, duration])
  return v
}
