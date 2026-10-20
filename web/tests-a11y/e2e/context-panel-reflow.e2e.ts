// Context panel in French and English at 320 x 568 and 640 x 512 (1280 px at 200 %), measured in a real browser on the harness of
// context-panel.ts (the demo declares the panel unavailable, so it never draws the table, the files, the capabilities or the resume
// block, #599). Nothing may scroll sideways, leave the window, be cut or sit on top of another button (WCAG 1.4.10), and the
// Branch / Pull request / Checks table stays readable: its three headers and every cell sit inside the panel, uncut. The measurements
// are printed for each size and locale.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { waitForStableLayout } from './stable-layout'
import { expectFits } from './panel-fit'
import { openContextPanel, MEASURE_TABLE, PANEL, type TableMeasure } from './context-panel'

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

async function open(w: number, h: number, locale: 'fr' | 'en'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  const page = await openContextPanel(context, server.url)
  await waitForStableLayout(page)
  return page
}

const HEADERS = { fr: ['Branche', 'Pull request', 'Vérifications'], en: ['Branch', 'Pull request', 'Checks'] }
const HEADING = { fr: 'CONTEXTE DU PROJET', en: 'PROJECT CONTEXT' }

for (const locale of ['fr', 'en'] as const) {
  for (const [w, h] of [[320, 568], [640, 512]] as Array<[number, number]>) {
    test(`${locale} ${w}x${h}: the Context panel fits and its Branch / Pull request / Checks table is readable (#599)`, { timeout: 180_000 }, async () => {
      const page = await open(w, h, locale)
      try {
        const panel = page.locator(PANEL)
        assert.match(await panel.innerText(), new RegExp(HEADING[locale]), 'the heading is in the language of the panel')
        // every block of the panel is really drawn: resume, files, issues, capabilities, PRs
        for (const sel of ['section[aria-labelledby]', 'section[aria-label="CLAUDE.md"]', '#context-capabilities-title', '[data-testid="session-work"] table']) {
          assert.ok(await panel.locator(sel).first().isVisible(), `${sel} is drawn`)
        }
        await expectFits(page, PANEL, `${locale} ${w}x${h}`)

        const m = await page.evaluate(MEASURE_TABLE) as TableMeasure | null
        assert.ok(m, 'the table is drawn')
        console.log(`# ${locale} ${w}x${h}: panel ${m.panelW} px, table ${m.tableW} px (right edge ${m.tableRight} <= ${m.panelRight}), columns ${m.heads.map(x => `${x.text}=${x.w}`).join(', ')}, scroller ${m.scrollerScrollW}/${m.scrollerClientW}`)
        assert.deepEqual(m.heads.map(x => x.text), HEADERS[locale], 'three column headers, in the language of the panel')
        assert.ok(m.tableRight <= m.panelRight + 1, `the table stays inside the panel (${m.tableRight} > ${m.panelRight})`)
        assert.ok(m.scrollerScrollW <= m.scrollerClientW + 1, `the panel body does not scroll sideways (${m.scrollerScrollW} > ${m.scrollerClientW})`)
        assert.deepEqual(m.heads.filter(x => x.cut), [], 'no header is cut')
        assert.deepEqual(m.cells.filter(x => x.cut), [], 'no cell is cut')
        assert.ok(m.heads.every(x => x.w >= 24) && m.cells.every(x => x.w >= 24), 'no column is squeezed below 24 px')
      } finally {
        await page.context().close()
      }
    })
  }
}
