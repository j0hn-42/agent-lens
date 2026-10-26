// Summary of a Chrome DevTools trace (#661), read by perf-chrome-profile.ts. Pure: trace events in, numbers out.
//
// - A frame is one `FireAnimationFrame` (the draw loop's requestAnimationFrame callback) on a renderer main thread.
// - A Layout (or a style recalculation, `UpdateLayoutTree`) is forced when it runs inside a JavaScript task of the same thread (`FireAnimationFrame`,
//   `FunctionCall`, `EventDispatch`, `TimerFire`, `EvaluateScript`, `RunMicrotasks`): a script read a geometry
//   (offsetWidth, getBoundingClientRect...) after a write, the "Forced reflow" of the DevTools Performance panel.
//   A Layout outside them is the rendering step of the frame.
// - Raster is `RasterTask` on any thread (tile workers); Paint and style recalculation (`UpdateLayoutTree`) are
//   read on the main threads. A 2D canvas drawn in software (headless Chromium) is rasterised when its recorded
//   draw calls are played back, in the `Commit` of the main thread (hypothesis: no trace event is specific to the
//   canvas, so Commit is a proxy for its raster time that may include other work), not RasterTask.
// Times are in ms; per-frame values are null when the window holds no frame (nothing to divide by).

export interface TraceEvent {
  name: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  cat?: string
  args?: Record<string, unknown>
}

export interface Stat { mean: number | null; p50: number | null; p95: number | null }
export interface Total { count: number; ms: number }
export interface ForcedSource { kind: string; at: string; count: number }
export interface TraceSummary {
  frames: number
  frameMs: Stat
  frameIntervalMs: Stat
  layouts: Total
  forcedLayouts: Total
  forcedLayoutsPerFrame: number | null
  /** UpdateLayoutTree inside a JavaScript task: a geometry read after a style write that needed no layout */
  forcedStyleRecalcs: Total
  forcedStyleRecalcsPerFrame: number | null
  paint: Total
  styleRecalc: Total
  raster: Total
  /** Commit on the main threads: where a software 2D canvas would play its draw calls back (hypothesis; a proxy for its raster) */
  commit: Total
  script: Total
  /** Every task of the main threads (RunTask): what the page left of the main thread for input and rendering */
  mainBusy: Total
  /** Where the forced events come from: top frame of their JS stack (needs the devtools.timeline.stack category) */
  forcedSources: ForcedSource[]
  perFrameMs: { script: number | null; layout: number | null; forcedLayout: number | null; forcedStyleRecalc: number | null; paint: number | null; styleRecalc: number | null; raster: number | null; commit: number | null }
}

const JS_TASKS = new Set(['FireAnimationFrame', 'FunctionCall', 'EventDispatch', 'TimerFire', 'EvaluateScript', 'RunMicrotasks'])
const KEPT = new Set([...JS_TASKS, 'Layout', 'Paint', 'UpdateLayoutTree', 'RasterTask', 'RunTask', 'Commit'])

interface Span { name: string; key: string; start: number; end: number; args?: Record<string, unknown> }

const round = (n: number) => Math.round(n * 1000) / 1000

function stat(values: number[]): Stat {
  if (values.length === 0) return { mean: null, p50: null, p95: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return { mean: round(values.reduce((a, b) => a + b, 0) / values.length), p50: round(at(0.5)), p95: round(at(0.95)) }
}

/** Complete (X) events and B/E pairs, as spans in µs, for the names this summary reads. */
function spans(events: TraceEvent[]): Span[] {
  const out: Span[] = []
  const open = new Map<string, TraceEvent[]>()
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (!KEPT.has(e.name)) continue
    const key = `${e.pid}:${e.tid}`
    if (e.ph === 'X') out.push({ name: e.name, key, start: e.ts, end: e.ts + (e.dur ?? 0), args: e.args })
    else if (e.ph === 'B') {
      const k = `${key}:${e.name}`
      open.set(k, [...(open.get(k) ?? []), e])
    } else if (e.ph === 'E') {
      const k = `${key}:${e.name}`
      const stack = open.get(k)
      const b = stack?.pop()
      if (b) out.push({ name: e.name, key, start: b.ts, end: e.ts, args: b.args })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

interface StackFrame { url?: string; lineNumber?: number; columnNumber?: number }

/** Forced events grouped by the top frame of their stack (file name, line, column), most frequent first. */
function forcedSources(forced: Span[]): ForcedSource[] {
  const counts = new Map<string, ForcedSource>()
  for (const s of forced) {
    const data = (s.args?.beginData ?? s.args?.data) as { stackTrace?: StackFrame[] } | undefined
    const top = data?.stackTrace?.[0]
    if (!top) continue
    const at = `${(top.url ?? '').split('/').pop()}:${top.lineNumber ?? 0}:${top.columnNumber ?? 0}`
    const k = `${s.name} ${at}`
    const c = counts.get(k) ?? { kind: s.name, at, count: 0 }
    c.count++
    counts.set(k, c)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

export function summarizeTrace(events: TraceEvent[], window: { fromUs?: number; toUs?: number } = {}): TraceSummary {
  const mainThreads = new Set(events
    .filter(e => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
    .map(e => `${e.pid}:${e.tid}`))
  const from = window.fromUs ?? -Infinity
  const to = window.toUs ?? Infinity
  const all = spans(events).filter(s => s.start >= from && s.start < to)
  const onMain = all.filter(s => mainThreads.has(s.key))
  const named = (name: string, list = onMain) => list.filter(s => s.name === name)
  const ms = (list: Span[]) => round(list.reduce((t, s) => t + (s.end - s.start), 0) / 1000)
  const total = (list: Span[]): Total => ({ count: list.length, ms: ms(list) })

  const frames = named('FireAnimationFrame')
  const jsTasks = onMain.filter(s => JS_TASKS.has(s.name))
  const layouts = named('Layout')
  const insideJs = (s: Span) => jsTasks.some(j => j.key === s.key && j.start <= s.start && s.end <= j.end)
  const forced = layouts.filter(insideJs)
  const raster = named('RasterTask', all)
  const paint = named('Paint')
  const style = named('UpdateLayoutTree')
  const forcedStyle = style.filter(insideJs)
  const commit = named('Commit')

  const intervals: number[] = []
  const byThread = new Map<string, Span[]>()
  for (const f of frames) byThread.set(f.key, [...(byThread.get(f.key) ?? []), f])
  for (const list of byThread.values()) for (let i = 1; i < list.length; i++) intervals.push((list[i].start - list[i - 1].start) / 1000)

  const n = frames.length
  const per = (v: number) => (n === 0 ? null : round(v / n))
  return {
    frames: n,
    frameMs: stat(frames.map(f => (f.end - f.start) / 1000)),
    frameIntervalMs: stat(intervals),
    layouts: total(layouts),
    forcedLayouts: total(forced),
    forcedLayoutsPerFrame: per(forced.length),
    forcedStyleRecalcs: total(forcedStyle),
    forcedStyleRecalcsPerFrame: per(forcedStyle.length),
    paint: total(paint),
    styleRecalc: total(style),
    raster: total(raster),
    commit: total(commit),
    script: total(frames),
    mainBusy: total(named('RunTask')),
    forcedSources: forcedSources([...forced, ...forcedStyle]),
    perFrameMs: {
      script: per(ms(frames)),
      layout: per(ms(layouts)),
      forcedLayout: per(ms(forced)),
      forcedStyleRecalc: per(ms(forcedStyle)),
      paint: per(ms(paint)),
      styleRecalc: per(ms(style)),
      raster: per(ms(raster)),
      commit: per(ms(commit)),
    },
  }
}
