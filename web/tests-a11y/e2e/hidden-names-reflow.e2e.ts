// "N names hidden" in the row of the canvas controls (#594, WCAG 1.4.10, 2.5.8), measured in a real browser against the
// demo (?scenario=team10: names are hidden at the fit zoom). At 320, 390 and 1280 px wide, in French and in English, the
// row must stay inside the window with the button: no control past an edge, no horizontal scroll, none under a bar,
// 44 px targets under 768 px. The row is also measured without the button (removed from the DOM, the layout of develop)
// and both are logged in px, so the change the button makes is on record.
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
interface Row { vw: number; scrollW: number; header: Box; playback: Box; row: Box | null; button: Box | null; controls: Array<Box & { name: string; onTop: boolean }> }

/** A string so the TS transpiler injects no helper into the page */
const MEASURE = `(() => {
  const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const button = document.querySelector('[data-hidden-names]')
  const zoom = document.querySelector('[data-canvas-inset] [role="group"]')
  const row = zoom ? zoom.parentElement : null
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
    row: row ? box(row) : null, button: button ? box(button) : null, controls,
  }
})()`

const overlaps = (a: Box, b: Box) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1
const show = (o: Box | null) => o ? `${Math.round(o.l)},${Math.round(o.t)}-${Math.round(o.r)},${Math.round(o.b)}` : 'none'

async function open(locale: 'fr' | 'en', w: number, h: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
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
  for (const [w, h] of [[320, 568], [390, 844], [1280, 800]] as Array<[number, number]>) {
    test(`"names hidden" ${locale} ${w}x${h}: the row of the canvas controls stays inside the window (#594)`, { timeout: 120_000 }, async () => {
      const page = await open(locale, w, h)
      try {
        const button = page.locator('[data-hidden-names]')
        assert.equal(await button.count(), 1, `[${locale} ${w}x${h}] the button is drawn (names are hidden at the fit zoom)`)
        const text = (await button.textContent())?.trim() ?? ''
        assert.match(text, LABEL[locale])
        assert.equal(await page.getByRole('button', { name: text, exact: true }).count(), 1, 'its accessible name is its text')
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
        // Without the button (the row as on develop)
        await page.evaluate(`document.querySelector('[data-hidden-names]').remove()`)
        const before = await page.evaluate(MEASURE) as Row
        console.log(`${locale} ${w}x${h}: "${text}" ${show(m.button)} (${Math.round(m.button!.r - m.button!.l)} px wide); `
          + `row with the button ${show(m.row)} (${Math.round(m.row!.r - m.row!.l)} x ${Math.round(m.row!.b - m.row!.t)} px), `
          + `without ${show(before.row)} (${Math.round(before.row!.r - before.row!.l)} x ${Math.round(before.row!.b - before.row!.t)} px); `
          + `window ${m.vw} px, page scroll width ${m.scrollW} px`)
      } finally {
        await page.context().close()
      }
    })
  }
}
