// Framing against the bars (#378, lot 4), measured in a real browser on the tour demo (`pnpm --dir web run test:e2e`).
// On develop @ fe29117, after "Fit to view" with the Cost overlay at 1024 x 768, the workspace frame of the
// docs-site session ended at y 670 while the canvas controls (Legend, Tour, zoom, View) start at y 666 on top
// of the playback bar: the fit only reserved the playback bar, and the workspace frames were not framed.
// Every card, pill, frame and text the canvas draws in world space must stay between the top bar and the
// controls row, both for the automatic framing and after "Fit to view".
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
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

// Records, per frame of the graph canvas, the screen box of every text and rounded rectangle drawn under the
// camera transform (world space), and of every text drawn in screen space (halo titles, cost summary) as
// 'screen-text'. The framing check below only looks at the world-space items.
// A string so the TS transpiler injects no helper into the page.
const RECORDER = `(() => {
  window.__fitFrames = []
  const graph = (ctx) => !!(ctx.canvas && ctx.canvas.closest && ctx.canvas.closest('[data-agent-canvas-root]'))
  const world = (ctx) => { const m = ctx.getTransform(); const d = window.devicePixelRatio || 1; return Math.abs(m.a - d) > 1e-6 || Math.abs(m.e) > 1e-6 || Math.abs(m.f) > 1e-6 }
  const push = (ctx, kind, label, x0, y0, x1, y1) => {
    const f = window.__fitFrames
    if (!f.length || !(ctx.globalAlpha > 0.05)) return
    const m = ctx.getTransform(); const d = window.devicePixelRatio || 1
    const p = (x, y) => [(m.a * x + m.c * y + m.e) / d, (m.b * x + m.d * y + m.f) / d]
    const a = p(x0, y0), b = p(x1, y1)
    f[f.length - 1].push({ kind, label, l: Math.min(a[0], b[0]), t: Math.min(a[1], b[1]), r: Math.max(a[0], b[0]), b: Math.max(a[1], b[1]) })
  }
  const clear = CanvasRenderingContext2D.prototype.clearRect
  CanvasRenderingContext2D.prototype.clearRect = function (...a) {
    if (graph(this) && !world(this)) { window.__fitFrames.push([]); if (window.__fitFrames.length > 3) window.__fitFrames.shift() }
    return clear.apply(this, a)
  }
  const fill = CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, max) {
    if (graph(this)) {
      const w = this.measureText(String(text)).width
      const fm = /([\\d.]+)px/.exec(this.font); const fs = fm ? parseFloat(fm[1]) : 10
      const al = this.textAlign; const x0 = al === 'center' ? x - w / 2 : (al === 'right' || al === 'end') ? x - w : x
      const bl = this.textBaseline; const y0 = bl === 'top' ? y : bl === 'middle' ? y - fs / 2 : bl === 'bottom' ? y - fs : y - fs * 0.8
      push(this, world(this) ? 'text' : 'screen-text', String(text), x0, y0, x0 + w, y0 + fs)
    }
    return fill.call(this, text, x, y, max)
  }
  const rr = CanvasRenderingContext2D.prototype.roundRect
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (graph(this) && world(this)) push(this, 'rect', '', x, y, x + w, y + h)
    return rr.call(this, x, y, w, h, r)
  }
})()`

interface Box { kind: string; label: string; l: number; t: number; r: number; b: number }

/** The last complete frame: read between two animation frames, so the frame being drawn is finished. */
async function lastFrame(page: Page): Promise<Box[]> {
  return page.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
    const f = window.__fitFrames; r(f[f.length - 1] || [])
  })))`) as Promise<Box[]>
}

/** Top of the canvas controls row and bottom of the top bar, in client px */
async function bars(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(`(() => {
    const header = document.querySelector('header').getBoundingClientRect()
    const names = ['Legend', 'Tour this session', 'Zoom in', 'Zoom out', 'Fit to view', 'View']
    const controls = [...document.querySelectorAll('[data-agent-canvas-root] button')]
      .filter(b => names.some(n => (b.getAttribute('aria-label') || b.textContent || '').trim().endsWith(n)))
    const playback = [...document.querySelectorAll('[role="toolbar"]')].filter(t => /Playback|Review/i.test(t.getAttribute('aria-label') || ''))
    const tops = [...controls, ...playback].map(el => el.getBoundingClientRect()).filter(r => r.height > 0).map(r => r.top)
    return { top: header.bottom, bottom: Math.min(...tops) }
  })()`) as Promise<{ top: number; bottom: number }>
}

async function expectInsideBars(page: Page, scenario: string) {
  await page.waitForTimeout(1500)
  const { top, bottom } = await bars(page)
  const frame = (await lastFrame(page)).filter(o => o.kind !== 'screen-text')
  assert.ok(frame.length > 10, `[${scenario}] the graph drew its content (${frame.length} items)`)
  const width = page.viewportSize()!.width
  const out = frame.filter(o => o.t < top - 1 || o.b > bottom + 1 || o.l < -1 || o.r > width + 1)
  assert.deepEqual(
    out.map(o => `${o.kind} "${o.label.slice(0, 30)}" ${Math.round(o.l)},${Math.round(o.t)}-${Math.round(o.r)},${Math.round(o.b)}`), [],
    `[${scenario}] drawn under a bar (top bar ends at ${Math.round(top)}, controls start at ${Math.round(bottom)})`,
  )
}

const overlaps = (a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }) =>
  a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1
const show = (o: Box) => `"${o.label.slice(0, 30)}" ${Math.round(o.l)},${Math.round(o.t)}-${Math.round(o.r)},${Math.round(o.b)}`

// On develop @ f2cfe19 at 768 x 1024 the "Session payments-api" title (screen space) sat on the "Workspace
// payments-api" header drawn just under it, and a title clamped under the top bar could land under the
// collapsed Conversation pill (DOM over the canvas).
async function expectTitlesClear(page: Page, scenario: string) {
  const frame = await lastFrame(page)
  const titles = frame.filter(o => o.kind === 'screen-text' && o.label.trim().length > 0)
  assert.ok(titles.length > 0, `[${scenario}] the halo titles are drawn`)
  const headers = frame.filter(o => o.kind === 'text' && o.label.startsWith('Workspace'))
  const pill = await page.evaluate(`(() => {
    const el = document.querySelector('[data-canvas-cover]'); if (!el) return null
    const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }
  })()`) as Box | null
  const bad: string[] = []
  for (const t of titles) {
    for (const h of headers) if (overlaps(t, h)) bad.push(`title ${show(t)} on header ${show(h)}`)
    if (pill && overlaps(t, pill)) bad.push(`title ${show(t)} under the Conversation pill ${Math.round(pill.l)},${Math.round(pill.t)}-${Math.round(pill.r)},${Math.round(pill.b)}`)
  }
  assert.deepEqual(bad, [], `[${scenario}] halo titles covered`)
}

test('the framing keeps cards, frames and labels between the top bar and the controls row, at 1024 and 768 px (#378)', { timeout: 180_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: 'reduce' })
  await context.addInitScript(RECORDER)
  const page = await context.newPage()
  try {
    await page.goto(`${server.url}/?scenario=tour`, { waitUntil: 'networkidle' })
    // The three sessions and the teams of the tour are on screen by then
    await page.waitForTimeout(36_000)
    await page.getByRole('button', { name: 'Pause and review history' }).click()

    // Automatic framing (no "Fit to view")
    await expectInsideBars(page, 'auto 1024x768')
    await page.setViewportSize({ width: 768, height: 1024 })
    await expectInsideBars(page, 'auto 768x1024')
    await expectTitlesClear(page, 'auto 768x1024')

    // Cost overlay, then "Fit to view"
    await page.keyboard.press('$')
    for (const [w, h] of [[768, 1024], [1024, 768]] as const) {
      await page.setViewportSize({ width: w, height: h })
      await page.getByRole('button', { name: 'Fit to view' }).click()
      await expectInsideBars(page, `Cost + Fit to view ${w}x${h}`)
      if (w === 768) await expectTitlesClear(page, `Cost + Fit to view ${w}x${h}`)
    }
  } finally {
    await context.close()
  }
})
