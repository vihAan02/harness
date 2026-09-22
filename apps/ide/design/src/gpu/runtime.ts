// One WebGPU device (vgpu) and one frame loop drive every shader canvas on the page.
// Components register a layer (surface + effect + per-frame update); if WebGPU is missing,
// getGpu() resolves null and components keep their CSS fallback.
import { clock, effect, frame as renderFrame, frameLoop, init, surface, type Effect, type FrameLoopHandle, type Gpu, type Surface } from 'vgpu'

let gpuPromise: Promise<Gpu | null> | null = null

export function getGpu(): Promise<Gpu | null> {
  gpuPromise ??= (async () => {
    if (!('gpu' in navigator)) return null
    try {
      return await init()
    } catch (err) {
      console.warn('[harness] WebGPU unavailable, using CSS fallbacks', err)
      return null
    }
  })()
  return gpuPromise
}

interface Layer {
  surface: Surface
  fx: Effect
  canvas: HTMLCanvasElement
  update: (t: number) => Record<string, unknown> | undefined
}

const layers = new Set<Layer>()
let loop: FrameLoopHandle | null = null

function ensureLoop(gpu: Gpu) {
  if (loop) return
  const time = clock(gpu)
  const tick = (frame: Parameters<Parameters<typeof frameLoop>[1]>[0], t = time.time) => {
    for (const layer of layers) {
      if (layer.surface.disposed || !layer.canvas.isConnected || layer.canvas.clientWidth === 0) continue
      try {
        const values = layer.update(t)
        if (values) layer.fx.set(values)
        frame.pass({ target: layer.surface, clear: [0, 0, 0, 0] }, layer.fx)
      } catch (err) {
        console.warn('[harness] shader layer failed, dropping it', err)
        layers.delete(layer)
      }
    }
  }
  loop = frameLoop(gpu, f => tick(f), { fps: 60 })
  if (import.meta.env.DEV) {
    // rAF pauses in hidden tabs; lets tooling render a frame on demand for screenshots.
    (window as unknown as { __gpuFrame: (t?: number) => number }).__gpuFrame = (t = 4) => {
      renderFrame(gpu, f => tick(f, t))
      return layers.size
    }
  }
}

/**
 * Attaches a fragment shader to a canvas. Returns a disposer. `initial` seeds every uniform;
 * `update` returns the per-frame changes (or undefined when nothing changed).
 */
export async function attachShader(
  canvas: HTMLCanvasElement,
  source: string,
  initial: Record<string, unknown>,
  update: Layer['update'],
  opts: { dpr?: number; signal?: { cancelled: boolean } } = {},
): Promise<(() => void) | null> {
  const gpu = await getGpu()
  // The caller may have unmounted (or StrictMode re-run the effect) while the device was coming up.
  if (!gpu || !canvas.isConnected || opts.signal?.cancelled) return null
  let s: Surface
  let fx: Effect
  try {
    s = surface(gpu, canvas, {
      alphaMode: 'premultiplied',
      clearColor: [0, 0, 0, 0],
      dpr: opts.dpr ?? Math.min(window.devicePixelRatio || 1, 2),
    })
    fx = effect(gpu, source, { set: initial })
  } catch (err) {
    console.warn('[harness] could not attach shader', (err as { code?: string }).code ?? err)
    return null
  }
  const layer: Layer = { surface: s, fx, canvas, update }
  layers.add(layer)
  ensureLoop(gpu)
  return () => {
    layers.delete(layer)
    if (!s.disposed) s.dispose()
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
