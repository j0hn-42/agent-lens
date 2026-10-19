// Files & repeats panel with repeated reads (#518), measured in a real browser on the harness of files-repeats.ts (the demo repeats
// nothing). The section "Repeated reads and calls" is a native disclosure folded while files are listed, so the file list starts near
// the top of the panel; its summary keeps the count. In French at 320 px and at 1280 px / 200 % (a 640 x 512 window), folded and
// unfolded, nothing may scroll sideways, leave the window, be cut or sit on top of another button (WCAG 1.4.10). The measurements
// (where the file list starts, how many file rows are fully visible) are printed for each width and locale.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { waitForStableLayout } from './stable-layout'
import { expectFits } from './panel-fit'
import { openFilesRepeats, MEASURE, type Measure } from './files-repeats'

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

async function open(w: number, h: number, locale: 'fr' | 'en', query = ''): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  const page = await openFilesRepeats(context, server.url, query)
  await waitForStableLayout(page)
  return page
}

const PANEL = '[data-dock-panel="files"]'

test('measure: where the file list starts with 5 repeats and 8 files (#518)', { timeout: 240_000 }, async () => {
  for (const locale of ['fr', 'en'] as const) {
    for (const [w, h] of [[320, 568], [390, 844], [768, 1024], [1280, 800]] as Array<[number, number]>) {
      const page = await open(w, h, locale)
      try {
        const m = await page.evaluate(MEASURE) as Measure | null
        assert.ok(m, `${locale} ${w}x${h}: the panel and its region are drawn`)
        console.log(`# ${locale} ${w}x${h}: panel ${m.panelW}x${m.panelH}, first file row at ${m.firstFileTop} px, ${m.visible}/${m.total} file rows fully visible`)
      } finally {
        await page.context().close()
      }
    }
  }
})

for (const [w, h] of [[320, 568], [640, 512]] as Array<[number, number]>) {
  test(`fr ${w}x${h}: the repeats fold, open with Enter and Space, and the panel fits both ways (#518)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h, 'fr')
    try {
      const panel = page.locator(PANEL)
      await panel.getByRole('region', { name: 'Fichiers et répétitions observés' }).waitFor()
      const summary = panel.locator('details > summary').first()
      await assert.doesNotReject(summary.waitFor(), 'the repeats are a native disclosure')
      assert.match(await summary.innerText(), /^Lectures et appels répétés : 5 observés$/)
      const details = panel.locator('details').first()
      assert.equal(await details.evaluate(d => (d as HTMLDetailsElement).open), false, 'folded while files are listed')
      await expectFits(page, PANEL, `${w}x${h} folded`)

      await summary.focus()
      await page.keyboard.press('Enter')
      assert.equal(await details.evaluate(d => (d as HTMLDetailsElement).open), true, 'Enter opens it')
      await waitForStableLayout(page)
      await expectFits(page, PANEL, `${w}x${h} unfolded`)
      await page.keyboard.press('Space')
      assert.equal(await details.evaluate(d => (d as HTMLDetailsElement).open), false, 'Space folds it again')
      // The focus ring of the summary is drawn (WCAG 2.4.7): an outline or a box-shadow while it has the keyboard focus
      const ring = await summary.evaluate(s => { const c = getComputedStyle(s); return { outline: c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0, shadow: c.boxShadow !== 'none' } })
      assert.ok(ring.outline || ring.shadow, `a visible focus ring (${JSON.stringify(ring)})`)
    } finally {
      await page.context().close()
    }
  })
}
