// Canvas controls at reflow sizes (#515, after #378 and #476; WCAG 1.4.10), measured in a real browser against the demo app
// (`pnpm --dir web run test:e2e`). On develop @ 270534c, at 320 x 256 (1280 x 1024 at 400 %) the top bar ends at y 124
// and the playback bar starts at y 142: 18 px are left for the canvas controls, which need two rows of 44 px targets
// (Legend and Tour, then Zoom in, Zoom out, Fit to view and View). They were drawn from y 38 to 134, under the top bar
// (z-index Z.topBar): all six were hidden behind it, a pointer could not reach them and a keyboard user tabbed to
// invisible controls. At 256 x 320 the top bar ends at y 168 and the playback bar starts at y 206 (38 px left): Legend
// and Tour were hidden the same way. Every control must stay visible and reachable, without covering either bar.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { waitForStableLayout } from './stable-layout'

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

/** The six canvas controls, in their Tab order. "Tour" is the guided tour button (#guided-tour-start), whose label changes */
const CONTROLS = ['Legend', 'Tour', 'Zoom in', 'Zoom out', 'Fit to view', 'View']
/** Shown instead of the six when they do not fit between the bars */
const MENU = 'Canvas controls'

interface Box { l: number; t: number; r: number; b: number }
interface Control extends Box { name: string; inPlayback: boolean; onTop: boolean }
interface Measure { vw: number; header: Box; playback: Box; controls: Control[] }

// A string so the TS transpiler injects no helper into the page. A control's name is its aria-label or its text
// without the disclosure arrow ("Tour" for the guided tour button); "onTop" says the control itself is hit at its centre (not a bar drawn over it).
const MEASURE = (names: string[]) => `(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const names = ${JSON.stringify(names)}
  const playback = document.querySelector('[data-control-bar]')
  const nameOf = b => b.id === 'guided-tour-start' ? 'Tour' : (b.getAttribute('aria-label') || b.textContent || '').replace(/[\\u25b8\\u25be]/g, '').trim()
  const controls = [...document.querySelectorAll('button')]
    .filter(b => !b.closest('header') && names.includes(nameOf(b)))
    .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    .map(b => {
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { name: nameOf(b), ...box(b), inPlayback: playback.contains(b), onTop: !!hit && b.contains(hit) }
    })
  return { vw: innerWidth, header: box(document.querySelector('header')), playback: box(playback), controls }
})()`

const overlaps = (a: Box, b: Box) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1
const show = (o: Box) => `${Math.round(o.l)},${Math.round(o.t)}-${Math.round(o.r)},${Math.round(o.b)}`

async function open(w: number, h: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  // The guided tour button comes with the demo session; folded, the "Canvas controls" button stands for it
  await page.waitForFunction(`!!(document.getElementById('guided-tour-start') || document.querySelector('[data-canvas-controls-slot] button'))`)
  await waitForStableLayout(page)
  return page
}

/** Every drawn control is on top of what is under it, 44 px under 768 px (#476), and covers neither bar unless it is part of the playback bar */
function expectClear(m: Measure, scenario: string) {
  const bad: string[] = []
  for (const c of m.controls) {
    if (!c.onTop) bad.push(`"${c.name}" ${show(c)} is drawn under something else`)
    if (overlaps(c, m.header)) bad.push(`"${c.name}" ${show(c)} on the top bar ${show(m.header)}`)
    if (!c.inPlayback && overlaps(c, m.playback)) bad.push(`"${c.name}" ${show(c)} on the playback bar ${show(m.playback)}`)
    if (m.vw < 768 && (c.r - c.l < 44 || c.b - c.t < 44)) bad.push(`"${c.name}" is ${Math.round(c.r - c.l)}x${Math.round(c.b - c.t)} px (44 px under 768 px, #476)`)
  }
  assert.deepEqual(bad, [], `[${scenario}] canvas controls`)
}

/** Name of the focused element, its box and whether the focus ring (2 px at 2 px offset) is clipped by the window or a scrolling ancestor */
const FOCUSED = `(() => {
  const a = document.activeElement
  if (!a || a === document.body) return null
  const r = a.getBoundingClientRect()
  const ring = { l: r.left - 4, t: r.top - 4, r: r.right + 4, b: r.bottom + 4 }
  let clip = { l: 0, t: 0, r: innerWidth, b: innerHeight }
  for (let n = a.parentElement; n; n = n.parentElement) {
    const s = getComputedStyle(n)
    if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) {
      const c = n.getBoundingClientRect()
      clip = { l: Math.max(clip.l, c.left), t: Math.max(clip.t, c.top), r: Math.min(clip.r, c.right), b: Math.min(clip.b, c.bottom) }
    }
  }
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  return {
    name: a.id === 'guided-tour-start' ? 'Tour' : (a.getAttribute('aria-label') || a.textContent || '').replace(/[\\u25b8\\u25be]/g, '').trim(),
    clipped: ring.l < clip.l - 0.5 || ring.t < clip.t - 0.5 || ring.r > clip.r + 0.5 || ring.b > clip.b + 0.5,
    onTop: !!hit && a.contains(hit),
  }
})()`

interface Focused { name: string; clipped: boolean; onTop: boolean }

/** Tabs from the focused element and checks that the six controls come in order, visible, on top and with a ring that is not clipped */
async function expectTabOrder(page: Page, scenario: string) {
  const seen: string[] = []
  for (let i = 0; i < 12 && seen.length < CONTROLS.length; i++) {
    await page.keyboard.press('Tab')
    const f = await page.evaluate(FOCUSED) as Focused | null
    if (!f || !CONTROLS.includes(f.name)) continue
    seen.push(f.name)
    assert.ok(f.onTop, `[${scenario}] "${f.name}" has the focus but is drawn under something else`)
    assert.ok(!f.clipped, `[${scenario}] the focus ring of "${f.name}" is clipped`)
  }
  assert.deepEqual(seen, CONTROLS, `[${scenario}] Tab reaches the canvas controls in order`)
}

for (const [w, h] of [[320, 256], [256, 320], [320, 568], [390, 844], [640, 512]] as Array<[number, number]>) {
  test(`canvas controls ${w}x${h}: visible, reachable, covering neither bar (#515)`, { timeout: 120_000 }, async () => {
    const page = await open(w, h)
    try {
      const m = await page.evaluate(MEASURE([...CONTROLS, MENU])) as Measure
      assert.ok(m.playback.t >= m.header.b - 1, `[${w}x${h}] the playback bar ${show(m.playback)} starts under the top bar ${show(m.header)}`)
      assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll')
      expectClear(m, `${w}x${h} at rest`)

      const menu = m.controls.find(c => c.name === MENU)
      if (!menu) {
        // They fit: all six are drawn, in order
        assert.deepEqual(m.controls.map(c => c.name), CONTROLS, `[${w}x${h}] the six controls are drawn`)
        await page.getByRole('button', { name: 'Legend' }).focus()
        await page.keyboard.press('Shift+Tab')
        await expectTabOrder(page, `${w}x${h}`)
        return
      }
      // Folded into one named button: none of the six is drawn (nor in the Tab order) until it is opened
      assert.deepEqual(m.controls.map(c => c.name), [MENU], `[${w}x${h}] only "${MENU}" is drawn`)
      const toggle = page.getByRole('button', { name: MENU, exact: true })
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
      for (const name of CONTROLS.filter(n => n !== 'Tour')) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `"${name}" is folded`)
      assert.equal(await page.locator('#guided-tour-start').count(), 0, 'the guided tour button is folded')

      // Keyboard: Enter opens it, the next Tab stops are the six controls, Escape closes it and gives the focus back
      await toggle.focus()
      await page.keyboard.press('Enter')
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
      await page.locator('#guided-tour-start').waitFor()
      const opened = await page.evaluate(MEASURE(CONTROLS)) as Measure
      assert.deepEqual(opened.controls.map(c => c.name), CONTROLS, `[${w}x${h}] opened: the six controls are drawn`)
      for (const c of opened.controls) {
        assert.ok(c.onTop, `[${w}x${h}] opened: "${c.name}" ${show(c)} is drawn under something else`)
        if (w < 768) assert.ok(c.r - c.l >= 44 && c.b - c.t >= 44, `[${w}x${h}] opened: "${c.name}" is ${Math.round(c.r - c.l)}x${Math.round(c.b - c.t)} px`)
        assert.ok(c.l >= 0 && c.r <= w && c.t >= 0 && c.b <= h, `[${w}x${h}] opened: "${c.name}" ${show(c)} is inside the window`)
      }
      await expectTabOrder(page, `${w}x${h} opened`)
      await page.keyboard.press('Escape')
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'Escape closes it')
      assert.equal((await page.evaluate(FOCUSED) as Focused | null)?.name, MENU, 'the focus goes back to it')
      assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll')
    } finally {
      await page.context().close()
    }
  })
}
