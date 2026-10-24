/**
 * Test helpers for the canvas draw functions (#378):
 * - `@/` imports of web/ resolve under node:test (the draw modules use the Next.js alias);
 * - a recording 2D context that tracks the current uniform scale, so a test can read the on-screen
 *   size of every text and rectangle a draw function produces.
 * Imported first by the tests that need it (side effect: registers the resolve hook).
 */
import nodeModule from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

type ResolveNext = (spec: string, ctx: unknown) => unknown
interface ModuleWithHooks { registerHooks?: (hooks: { resolve: (spec: string, ctx: unknown, next: ResolveNext) => unknown }) => unknown }

const webRoot = pathToFileURL(path.resolve(__dirname, '../web') + '/').href
const registerHooks = (nodeModule as unknown as ModuleWithHooks).registerHooks
if (!registerHooks) throw new Error('canvas-recorder needs module.registerHooks (Node >= 22.15)')
registerHooks({
  resolve(spec, ctx, next) {
    return next(spec.startsWith('@/') ? webRoot + spec.slice(2) : spec, ctx)
  },
})

export interface DrawnText { text: string; screenPx: number }
export interface DrawnRect { x: number; y: number; w: number; h: number; screenW: number; screenH: number }

/** One call on the context, with the line width and dash in effect and the uniform scale */
export interface DrawnOp {
  name: string; args: unknown[]; lineWidth: number; lineDash: number[]; scale: number
  /** Paint state in effect (#378): lets a test check that a plate under a text is opaque and drawn in a theme token */
  fillStyle: string; globalAlpha: number; textAlign: string; textBaseline: string; font: string
  /** Stroke colour in effect (#381): lets a test measure the contrast of every line a draw function strokes */
  strokeStyle: string
}

export interface Recording {
  ctx: CanvasRenderingContext2D
  texts: DrawnText[]
  rects: DrawnRect[]
  /** Every method call, in order: lets a test compare the shapes drawn, whatever their colours */
  ops: DrawnOp[]
}

/** A 2D context that records texts (with their on-screen size) and rounded rectangles. `zoom` is the camera scale already applied. */
export function recordingContext(zoom: number): Recording {
  const texts: DrawnText[] = []
  const rects: DrawnRect[] = []
  const ops: DrawnOp[] = []
  const saved = ['lineWidth', 'fillStyle', 'strokeStyle', 'globalAlpha', 'textAlign', 'textBaseline', 'font'] as const
  const stack: { scale: number; lineDash: number[]; values: Record<string, unknown> }[] = []
  let scale = zoom
  let lineDash: number[] = []
  const state: Record<string | symbol, unknown> = { font: '10px sans-serif', globalAlpha: 1, lineWidth: 1, fillStyle: '#000000', strokeStyle: '#000000', textAlign: 'start', textBaseline: 'alphabetic' }
  const fontPx = () => Number(/(\d+(?:\.\d+)?)px/.exec(String(state.font))?.[1] ?? 10)
  const methods: Record<string, (...args: number[] | unknown[]) => unknown> = {
    save: () => { stack.push({ scale, lineDash, values: Object.fromEntries(saved.map(k => [k, state[k]])) }) },
    restore: () => {
      const top = stack.pop()
      if (top) { scale = top.scale; lineDash = top.lineDash; Object.assign(state, top.values) }
    },
    setLineDash: (...a) => { lineDash = [...(a[0] as number[])] },
    scale: (...a) => { scale *= Number(a[0]) },
    setTransform: () => { scale = zoom },
    fillText: (...a) => { texts.push({ text: String(a[0]), screenPx: fontPx() * scale }) },
    strokeText: () => undefined,
    roundRect: (...a) => {
      const [x, y, w, h] = a.map(Number)
      rects.push({ x, y, w, h, screenW: w * scale, screenH: h * scale })
    },
    measureText: (...a) => ({ width: String(a[0]).length * fontPx() * 0.6 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    getLineDash: () => [...lineDash],
  }
  const call = (name: string) => (...args: unknown[]) => {
    ops.push({
      name, args, lineWidth: Number(state.lineWidth), lineDash: [...lineDash], scale,
      fillStyle: String(state.fillStyle), strokeStyle: String(state.strokeStyle), globalAlpha: Number(state.globalAlpha),
      textAlign: String(state.textAlign), textBaseline: String(state.textBaseline), font: String(state.font),
    })
    return methods[name] ? methods[name](...(args as number[])) : undefined
  }
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in methods) return call(prop)
      if (prop in target) return target[prop]
      return typeof prop === 'string' ? call(prop) : undefined
    },
    set(target, prop, value) { target[prop] = value; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, texts, rects, ops }
}

/** Glow sprites are drawn on off-screen canvases: a stub `document` is enough under node. */
export function stubDocument(): void {
  const g = globalThis as { document?: unknown }
  if (g.document) return
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => recordingContext(1).ctx }) }
}
