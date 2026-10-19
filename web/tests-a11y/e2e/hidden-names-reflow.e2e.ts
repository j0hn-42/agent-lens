// "N names hidden" in the row of the canvas controls (#594, WCAG 1.4.10, 2.5.8), measured in a real browser against the
// demo (?scenario=team10: names are hidden at the fit zoom). At 320, 390 and 1280 px wide, in French and in English, the
// row must stay inside the window with the button: no control past an edge, no horizontal scroll, none under a bar,
// 44 px targets under 768 px. The row is also measured without the button (removed from the DOM, the layout of develop)
// and with its widest label: Zoom in, Zoom out, Fit to view and View must not move by a pixel in either case (the
// button sits before them, on the side the row is not anchored to), so its coming, going or new width never moves a
// control under the pointer.
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

interface Box { l: number; t: number; r: number; b: number }
interface Row { vw: number; scrollW: number; header: Box; playback: Box; row: Box | null; button: Box | null; fixed: Array<Box & { name: string }>; controls: Array<Box & { name: string; onTop: boolean }> }

/** A string so the TS transpiler injects no helper into the page */
const MEASURE = `(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const button = document.querySelector('[data-hidden-names]')
  const zoom = document.querySelector('[data-canvas-inset] [role="group"]')
  const zoomRow = zoom ? zoom.closest('[data-canvas-inset]') : null
  const row = zoomRow ? zoomRow.parentElement : null
  const fixed = zoomRow ? [...zoomRow.querySelectorAll('button')].map(b => ({ name: (b.getAttribute('aria-label') || b.textContent || '').trim(), ...box(b) })) : []
  const controls = row ? [...row.closest('[lang]').querySelectorAll('button')]
    .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    .map(b => {
      const r = b.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { name: (b.getAttribute('aria-label') || b.textContent || '').trim(), ...box(b), onTop: !!hit && b.contains(hit) }
    }) : []
  return {
    vw: innerWidth, scrollW: document.documentElement.scrollWidth,
    header: box(document.querySelector('header')), playback: box(document.querySelector('[data-control-bar]')),
    row: row ? box(row) : null, button: button ? box(button) : null, fixed, controls,
  }
})()`

/**
 * Recorded on every frame from the page's start: the "names hidden" button (absent, or its text) and the box of Zoom in.
 * Whenever the button appears, goes or changes text, Zoom in must be where it was on the frame before.
 */
const TRACK = `(() => {
  const frames = []
  window.__hiddenNamesFrames = frames
  const step = () => {
    const zoomIn = document.querySelector('[data-canvas-inset] [role="group"] button')
    if (zoomIn) {
      const b = document.querySelector('[data-hidden-names]')
      const r = zoomIn.getBoundingClientRect()
      const prev = frames[frames.length - 1]
      const cur = { button: b ? (b.textContent || '').trim() : null, zoom: [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') }
      if (!prev || prev.button !== cur.button || prev.zoom !== cur.zoom) frames.push(cur)
    }
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
})()`

const overlaps = (a: Box, b: Box) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1
const show = (o: Box | null) => o ? `${Math.round(o.l)},${Math.round(o.t)}-${Math.round(o.r)},${Math.round(o.b)}` : 'none'

async function open(locale: 'fr' | 'en', w: number, h: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  await context.addInitScript(TRACK)
  const page = await context.newPage()
  await page.goto(`${server.url}/?scenario=team10`, { waitUntil: 'networkidle' })
  await page.locator('header').waitFor()
  await page.locator('[data-hidden-names], [data-canvas-controls-slot] button').first().waitFor({ timeout: 60_000 })
  await waitForStableLayout(page)
  // the count follows the camera: wait until the button and its text stop changing
  let prev = ''
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300)
    const cur = JSON.stringify(await page.evaluate(MEASURE)) + (await page.locator('[data-hidden-names]').textContent().catch(() => ''))
    if (cur === prev) break
    prev = cur
  }
  return page
}

const LABEL = { fr: /^\d+ noms? masqués?$/, en: /^\d+ names? hidden$/ }

for (const locale of ['fr', 'en'] as const) {
  for (const [w, h] of [[320, 568], [390, 844], [420, 844], [1280, 800]] as Array<[number, number]>) {
    test(`"names hidden" ${locale} ${w}x${h}: the row of the canvas controls stays inside the window (#594)`, { timeout: 120_000 }, async () => {
      const page = await open(locale, w, h)
      try {
        const button = page.locator('[data-hidden-names]')
        assert.equal(await button.count(), 1, `[${locale} ${w}x${h}] the button is drawn (names are hidden at the fit zoom)`)
        const text = (await button.textContent())?.trim() ?? ''
        assert.match(text, LABEL[locale])
        assert.equal(await page.getByRole('button', { name: text, exact: true }).count(), 1, 'its accessible name is its text')
        // Each real appearance or change of the button since the page opened left Zoom in in place
        const frames = await page.evaluate('window.__hiddenNamesFrames') as Array<{ button: string | null; zoom: string }>
        const changes = frames.slice(1).map((f, i) => ({ from: frames[i], to: f })).filter(c => c.from.button !== c.to.button)
        assert.ok(changes.some(c => c.from.button === null && c.to.button !== null), `[${locale} ${w}x${h}] the button appeared while recorded: ${JSON.stringify(frames)}`)
        for (const c of changes) assert.equal(c.to.zoom, c.from.zoom, `[${locale} ${w}x${h}] "${c.from.button}" -> "${c.to.button}" moved Zoom in`)
        const m = await page.evaluate(MEASURE) as Row
        const bad: string[] = []
        if (m.scrollW > m.vw) bad.push(`horizontal scroll: ${m.scrollW} > ${m.vw}`)
        for (const c of m.controls) {
          if (c.l < 0 || c.r > m.vw) bad.push(`"${c.name}" ${show(c)} past the window (${m.vw} px)`)
          if (!c.onTop) bad.push(`"${c.name}" ${show(c)} is drawn under something else`)
          if (overlaps(c, m.header)) bad.push(`"${c.name}" ${show(c)} on the top bar ${show(m.header)}`)
          if (overlaps(c, m.playback)) bad.push(`"${c.name}" ${show(c)} on the playback bar ${show(m.playback)}`)
          if (m.vw < 768 && (c.r - c.l < 44 - 0.5 || c.b - c.t < 44 - 0.5)) bad.push(`"${c.name}" is ${Math.round(c.r - c.l)}x${Math.round(c.b - c.t)} px`)
        }
        assert.deepEqual(bad, [], `[${locale} ${w}x${h}] with the button`)
        assert.equal(m.fixed.length, 4, 'Zoom in, Zoom out, Fit to view, View')
        // Its widest label (the neutral one, shown while the count changes, or a 3-digit count): nothing moves, and from
        // 420 px it stays on the zoom row (the fit test reserves a row under 420 px only)
        const widest = locale === 'fr' ? ['Sessions et agents', '100 noms masqués'] : ['Sessions and agents', '100 names hidden']
        for (const label of widest) {
          await page.evaluate(`document.querySelector('[data-hidden-names]').textContent = ${JSON.stringify(label)}`)
          const wide = await page.evaluate(MEASURE) as Row
          assert.deepEqual(wide.fixed, m.fixed, `[${locale} ${w}x${h}] "${label}": the zoom buttons and View did not move`)
          assert.ok(wide.scrollW <= wide.vw, `[${locale} ${w}x${h}] "${label}": no horizontal scroll`)
          assert.ok(wide.button!.l >= 0, `[${locale} ${w}x${h}] "${label}": inside the window (${show(wide.button)})`)
          // Same line: the vertical centres agree (above 768 px the text button is 2 px taller than the icon buttons)
          if (w >= 420) assert.ok(Math.abs((wide.button!.t + wide.button!.b) - (wide.fixed[0].t + wide.fixed[0].b)) < 2,`[${locale} ${w}x${h}] "${label}" on the zoom row: ${show(wide.button)} vs ${show(wide.fixed[0])}`)
        }
        // Without the button (the row as on develop): the zoom buttons and View are exactly where they were
        await page.evaluate(`document.querySelector('[data-hidden-names]').remove()`)
        const before = await page.evaluate(MEASURE) as Row
        assert.deepEqual(before.fixed, m.fixed, `[${locale} ${w}x${h}] with and without the button, Zoom in is at ${show(m.fixed[0])} / ${show(before.fixed[0])}`)
        console.log(`${locale} ${w}x${h}: "${text}" ${show(m.button)} (${Math.round(m.button!.r - m.button!.l)} px wide); `
          + `row with the button ${show(m.row)} (${Math.round(m.row!.r - m.row!.l)} x ${Math.round(m.row!.b - m.row!.t)} px), `
          + `without ${show(before.row)} (${Math.round(before.row!.r - before.row!.l)} x ${Math.round(before.row!.b - before.row!.t)} px); `
          + `Zoom in ${show(m.fixed[0])} with and without; window ${m.vw} px, page scroll width ${m.scrollW} px`)
      } finally {
        await page.context().close()
      }
    })
  }
}

// Folded (320 x 256, #515): the button is in the "Canvas controls" block, after View, under the zoom buttons so they stay
// in view when the block opens; the block scrolls, and Tab brings the button into view, on top and not clipped.
for (const locale of ['fr', 'en'] as const) {
  test(`"names hidden" ${locale} 320x256, folded: reached by Tab after View, in view and on top (#594)`, { timeout: 120_000 }, async () => {
    const page = await open(locale, 320, 256)
    try {
      await page.locator('[data-canvas-controls-slot] button').first().click()
      const view = page.getByRole('button', { name: locale === 'fr' ? 'Affichage' : 'View', exact: true })
      await view.focus()
      await page.keyboard.press('Tab')
      const f = await page.evaluate(`(() => {
        const a = document.activeElement
        const r = a.getBoundingClientRect()
        const c = a.closest('[role="group"][aria-label]:not([aria-label="Zoom"])').getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return { hidden: a.hasAttribute('data-hidden-names'), text: (a.textContent || '').trim(), onTop: !!hit && a.contains(hit),
          inBlock: r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5,
          w: r.width, h: r.height }
      })()`) as { hidden: boolean; text: string; onTop: boolean; inBlock: boolean; w: number; h: number }
      assert.ok(f.hidden, `Tab after View reaches the "names hidden" button (focused: "${f.text}")`)
      assert.match(f.text, LABEL[locale])
      assert.ok(f.onTop, 'it is drawn on top')
      assert.ok(f.inBlock, 'the block scrolled it into view')
      assert.ok(f.w >= 44 - 0.5 && f.h >= 44 - 0.5, `${Math.round(f.w)}x${Math.round(f.h)} px`)
      console.log(`${locale} 320x256 folded: "${f.text}" ${Math.round(f.w)}x${Math.round(f.h)} px, in view after Tab`)
    } finally {
      await page.context().close()
    }
  })
}
