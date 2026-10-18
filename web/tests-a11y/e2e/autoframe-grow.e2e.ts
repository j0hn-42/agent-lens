// Automatic framing while the scene grows (#378, suite), measured in a real browser on the tour demo
// (`pnpm --dir web run test:e2e`), motion on (no reduced motion: that path jumps to its target).
// On develop @ 03da64a the camera closed 6 % of the gap to its fit target per frame: an agent, a card or a workspace
// frame that appeared outside the frame stayed (partly) outside for up to 657 ms, the token line of an agent included.
// Every frame drawn is checked in the page: the longest run of frames with something drawn in world space outside the
// band between the top bar and the controls row (or past a side edge) must stay short. Measured over 40 s (about
// 2 300 frames per size), before / after the catch-up: 1024 x 768, 137 / 27 frames with an item outside, longest run
// 657 / 100 ms; 390 x 844, 106 / 17-19 frames, 468 / 99-116 ms (two runs after). A card or an agent can still spawn outside the frame (worst
// item about 220 px off on its first frame): the camera then brings it in within a few frames.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'

let browser: Browser
let server: DemoServer
before(async () => {
  server = await startDemoServer()
  browser = await chromium.launch()
}, { timeout: 240_000 })
after(async () => {
  await browser?.close()
  await server?.stop()
})

// Per frame of the graph canvas (clearRect in screen space starts one), the screen box of every text and rounded
// rectangle drawn under the camera transform; when a frame ends, how far its worst item sticks out of the band.
// A string so the TS transpiler injects no helper into the page.
const RECORDER = `(() => {
  const S = window.__autoframe = { frames: 0, outFrames: 0, maxPx: 0, maxWhat: '', runMs: 0, runStart: 0, longestMs: 0, longestWhat: '', tokenMaxPx: 0, cur: null, bars: null, barsAt: 0 }
  const graph = (ctx) => !!(ctx.canvas && ctx.canvas.closest && ctx.canvas.closest('[data-agent-canvas-root]'))
  const world = (ctx) => { const m = ctx.getTransform(); const d = window.devicePixelRatio || 1; return Math.abs(m.a - d) > 1e-6 || Math.abs(m.e) > 1e-6 || Math.abs(m.f) > 1e-6 }
  const bars = () => {
    const now = performance.now()
    if (S.bars && now - S.barsAt < 250) return S.bars
    const header = document.querySelector('header'); if (!header) return null
    const names = ['Legend', 'Tour this session', 'Zoom in', 'Zoom out', 'Fit to view', 'View']
    const controls = [...document.querySelectorAll('[data-agent-canvas-root] button')]
      .filter(b => names.some(n => (b.getAttribute('aria-label') || b.textContent || '').trim().endsWith(n)))
    const playback = [...document.querySelectorAll('[role="toolbar"]')].filter(t => /Playback|Review/i.test(t.getAttribute('aria-label') || ''))
    const tops = [...controls, ...playback].map(el => el.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.top)
    S.bars = { top: header.getBoundingClientRect().bottom, bottom: tops.length ? Math.min(...tops) : innerHeight, width: innerWidth }
    S.barsAt = now
    return S.bars
  }
  const end = () => {
    const f = S.cur; if (!f) return
    const b = bars(); if (!b || !f.items.length) return
    let worst = 0, what = ''
    for (const o of f.items) {
      const v = Math.max(0, b.top - o.t, o.b - b.bottom, -o.l, o.r - b.width)
      if (/tokens/.test(o.label)) S.tokenMaxPx = Math.max(S.tokenMaxPx, v)
      if (v > worst) { worst = v; what = o.kind + ' "' + o.label.slice(0, 40) + '" ' + Math.round(o.l) + ',' + Math.round(o.t) + '-' + Math.round(o.r) + ',' + Math.round(o.b) }
    }
    S.frames++
    if (worst > 1) {
      S.outFrames++
      if (worst > S.maxPx) { S.maxPx = worst; S.maxWhat = what }
      if (!S.runStart) S.runStart = f.at
      const run = f.at - S.runStart
      if (run > S.longestMs) { S.longestMs = run; S.longestWhat = what }
    } else S.runStart = 0
  }
  const push = (ctx, kind, label, x0, y0, x1, y1) => {
    if (!S.cur || !(ctx.globalAlpha > 0.05)) return
    const m = ctx.getTransform(); const d = window.devicePixelRatio || 1
    const p = (x, y) => [(m.a * x + m.c * y + m.e) / d, (m.b * x + m.d * y + m.f) / d]
    const a = p(x0, y0), c = p(x1, y1)
    S.cur.items.push({ kind, label, l: Math.min(a[0], c[0]), t: Math.min(a[1], c[1]), r: Math.max(a[0], c[0]), b: Math.max(a[1], c[1]) })
  }
  const clear = CanvasRenderingContext2D.prototype.clearRect
  CanvasRenderingContext2D.prototype.clearRect = function (...a) {
    if (graph(this) && !world(this)) { end(); S.cur = { at: performance.now(), items: [] } }
    return clear.apply(this, a)
  }
  const fill = CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, max) {
    if (graph(this) && world(this)) {
      const w = this.measureText(String(text)).width
      const fm = /([\\d.]+)px/.exec(this.font); const fs = fm ? parseFloat(fm[1]) : 10
      const al = this.textAlign; const x0 = al === 'center' ? x - w / 2 : (al === 'right' || al === 'end') ? x - w : x
      const bl = this.textBaseline; const y0 = bl === 'top' ? y : bl === 'middle' ? y - fs / 2 : bl === 'bottom' ? y - fs : y - fs * 0.8
      push(this, 'text', String(text), x0, y0, x0 + w, y0 + fs)
    }
    return fill.call(this, text, x, y, max)
  }
  const rr = CanvasRenderingContext2D.prototype.roundRect
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (graph(this) && world(this)) push(this, 'rect', '', x, y, x + w, y + h)
    return rr.call(this, x, y, w, h, r)
  }
})()`

interface Stats { frames: number; outFrames: number; maxPx: number; maxWhat: string; longestMs: number; longestWhat: string; tokenMaxPx: number }

/** Longest run (ms) a drawn item may stay outside the band: the fit refreshes its target every 4 frames, then catches up */
const MAX_RUN_MS = 250

test('while the tour grows, nothing stays outside the frame for more than 250 ms, at 1024 x 768 and 390 x 844 (#378)', { timeout: 240_000 }, async () => {
  const report: string[] = []
  const failures: string[] = []
  for (const [w, h] of [[1024, 768], [390, 844]] as const) {
    const context = await browser.newContext({ viewport: { width: w, height: h } })
    await context.addInitScript(RECORDER)
    const page = await context.newPage()
    try {
      await page.goto(`${server.url}/?scenario=tour`, { waitUntil: 'networkidle' })
      // The three sessions and the teams of the tour arrive within this time
      await page.waitForTimeout(40_000)
      const s = await page.evaluate('window.__autoframe') as Stats
      const line = `${w}x${h}: ${s.frames} frames, ${s.outFrames} with an item outside, worst ${s.maxPx.toFixed(1)} px (${s.maxWhat}), `
        + `longest run ${Math.round(s.longestMs)} ms (${s.longestWhat}), token line ${s.tokenMaxPx.toFixed(1)} px`
      report.push(line)
      assert.ok(s.frames > 200, `[${w}x${h}] the graph drew frames (${s.frames})`)
      if (s.longestMs > MAX_RUN_MS) failures.push(line)
    } finally {
      await context.close()
    }
  }
  console.log(report.join('\n'))
  assert.deepEqual(failures, [], `content stayed outside the frame for more than ${MAX_RUN_MS} ms`)
})
