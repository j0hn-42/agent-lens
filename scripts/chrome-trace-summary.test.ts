// Summary of a Chrome DevTools trace (#661): the numbers that perf-chrome-profile.ts prints for the before/after
// profile of the canvas. Each number is read from trace events, never estimated: a forced layout is a Layout that
// runs inside a JavaScript task on the same thread, a frame is one animation-frame callback.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { summarizeTrace, type TraceEvent } from '../web/tests-a11y/e2e/chrome-trace-summary'

const MAIN = { pid: 1, tid: 10 }
const meta: TraceEvent[] = [
  { name: 'thread_name', ph: 'M', ...MAIN, ts: 0, args: { name: 'CrRendererMain' } },
  { name: 'thread_name', ph: 'M', pid: 1, tid: 20, ts: 0, args: { name: 'CompositorTileWorker1' } },
]
const x = (name: string, ts: number, dur: number, at = MAIN): TraceEvent => ({ name, ph: 'X', ts, dur, ...at })

test('frames are the animation-frame callbacks of the renderer main thread, with their duration and interval', () => {
  const s = summarizeTrace([
    ...meta,
    x('FireAnimationFrame', 0, 4000),
    x('FireAnimationFrame', 16_000, 6000),
    x('FireAnimationFrame', 32_000, 2000),
    // Another thread's callback is not a frame of the page
    x('FireAnimationFrame', 40_000, 9000, { pid: 1, tid: 99 }),
  ])
  assert.equal(s.frames, 3)
  assert.equal(s.frameMs.mean, 4)
  assert.equal(s.frameIntervalMs.mean, 16)
})

test('a Layout inside a JavaScript task is forced; one outside (the rendering step) is not', () => {
  const s = summarizeTrace([
    ...meta,
    x('FireAnimationFrame', 0, 5000),
    x('Layout', 1000, 300), // offsetWidth read in the middle of the frame's writes
    x('FunctionCall', 8000, 1000),
    x('Layout', 8500, 200),
    x('Layout', 12_000, 400), // the frame's own layout, after the callbacks
  ])
  assert.equal(s.layouts.count, 3)
  assert.equal(s.forcedLayouts.count, 2)
  assert.equal(s.forcedLayouts.ms, 0.5)
  assert.equal(s.forcedLayoutsPerFrame, 2)
})

test('a style recalculation inside a JavaScript task is forced too (DevTools flags both)', () => {
  const s = summarizeTrace([
    ...meta,
    x('FireAnimationFrame', 0, 5000),
    x('UpdateLayoutTree', 1000, 200), // a geometry read after a style write: style only, no layout needed
    x('UpdateLayoutTree', 9000, 300), // the frame's own style step
  ])
  assert.equal(s.styleRecalc.count, 2)
  assert.equal(s.forcedStyleRecalcs.count, 1)
  assert.equal(s.forcedStyleRecalcs.ms, 0.2)
  assert.equal(s.forcedStyleRecalcsPerFrame, 1)
})

test('B/E pairs are measured like complete events', () => {
  const s = summarizeTrace([
    ...meta,
    { name: 'FireAnimationFrame', ph: 'B', ts: 0, ...MAIN },
    { name: 'Layout', ph: 'B', ts: 100, ...MAIN },
    { name: 'Layout', ph: 'E', ts: 600, ...MAIN },
    { name: 'FireAnimationFrame', ph: 'E', ts: 3000, ...MAIN },
  ])
  assert.equal(s.frames, 1)
  assert.equal(s.forcedLayouts.count, 1)
  assert.equal(s.forcedLayouts.ms, 0.5)
})

test('paint, style, raster (any thread) and JavaScript time are summed and given per frame', () => {
  const s = summarizeTrace([
    ...meta,
    x('FireAnimationFrame', 0, 4000),
    x('FireAnimationFrame', 16_000, 4000),
    x('Paint', 5000, 1000),
    x('UpdateLayoutTree', 5000, 500),
    x('RasterTask', 6000, 3000, { pid: 1, tid: 20 }),
    x('RasterTask', 22_000, 1000, { pid: 1, tid: 20 }),
  ])
  assert.equal(s.paint.ms, 1)
  assert.equal(s.styleRecalc.ms, 0.5)
  assert.equal(s.raster.ms, 4)
  assert.equal(s.raster.count, 2)
  assert.equal(s.perFrameMs.raster, 2)
  assert.equal(s.perFrameMs.script, 4)
})

test('main-thread busy time is the sum of its RunTask, other threads apart', () => {
  const s = summarizeTrace([
    ...meta,
    x('RunTask', 0, 3000),
    x('RunTask', 5000, 1000),
    x('RunTask', 0, 9000, { pid: 1, tid: 20 }),
  ])
  assert.equal(s.mainBusy.ms, 4)
  assert.equal(s.mainBusy.count, 2)
})

test('a window keeps only what starts inside it', () => {
  const s = summarizeTrace([
    ...meta,
    x('FireAnimationFrame', 0, 4000),
    x('FireAnimationFrame', 100_000, 4000),
    x('Layout', 101_000, 100),
  ], { fromUs: 50_000 })
  assert.equal(s.frames, 1)
  assert.equal(s.forcedLayouts.count, 1)
})

test('no frame: per-frame values are null, not zero', () => {
  const s = summarizeTrace([...meta, x('Layout', 0, 100)])
  assert.equal(s.frames, 0)
  assert.equal(s.forcedLayoutsPerFrame, null)
  assert.equal(s.frameMs.mean, null)
  assert.equal(s.perFrameMs.raster, null)
})
