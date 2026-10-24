// Finishes of #383, measured in a real browser against the demo app (`pnpm --dir web run test:e2e`):
//  - the "N messages" counter of the Conversation header stays on one line at every width;
//  - entering review mode no longer drops a toast over the bottom of the canvas: the state is announced once, by the
//    chrome live region, and the visible bar swaps to the review bar, whose button reads "▶ LIVE" and is named "Resume live" (aria-label).
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { topbarButton } from './topbar-fold'

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

async function open(w: number, h: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h } })
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  await waitForStableLayout(page)
  return page
}

// Runs in the page. A string so no transpiler helper is injected into it.
const MEASURE_COUNTER = `(() => {
  const panel = document.querySelector('[data-dock-panel="conversation"]')
  const h2 = panel.querySelector('h2')
  const span = [...h2.parentElement.querySelectorAll('span')].find(s => /\\bmessages?$/.test((s.textContent || '').trim()))
  const lh = parseFloat(getComputedStyle(span).lineHeight) || parseFloat(getComputedStyle(span).fontSize) * 1.5
  const r = span.getBoundingClientRect()
  return { text: span.textContent, height: r.height, lineHeight: lh, lines: Math.round(r.height / lh), width: r.width, panelWidth: panel.getBoundingClientRect().width, spanDisplay: getComputedStyle(span).display }
})()`

for (const w of [320, 390, 768, 1280]) {
  test(`conversation header ${w}px: the message counter is on one line`, async () => {
    const page = await open(w, 800)
    try {
      await (await topbarButton(page, /^Conversation/)).first().click()
      await page.locator('[data-dock-panel="conversation"]').waitFor()
      await waitForStableLayout(page)
      const m = await page.evaluate(MEASURE_COUNTER) as { text: string; height: number; lineHeight: number; lines: number; width: number }
      console.log(`counter ${w}px`, JSON.stringify(m))
      assert.equal(m.lines, 1, `"${m.text}" is drawn on ${m.lines} lines at ${w} px (height ${m.height}px, line ${m.lineHeight}px)`)
    } finally {
      await page.context().close()
    }
  })
}

test('review mode: no toast over the canvas, announced once', async () => {
  const page = await open(390, 800)
  try {
    await page.locator('[data-control-bar]').first().getByRole('button', { name: /Pause and review history/ }).click()
    await page.locator('[data-control-bar]').first().getByRole('button', { name: /Resume live/i }).waitFor()
    await page.waitForTimeout(500)
    const info = await page.evaluate(`(() => {
      const regions = [...document.querySelectorAll('[role="status"]')].map(e => (e.textContent || '').trim()).filter(t => /review mode/i.test(t))
      return { regions, toastText: document.body.innerText.includes('press LIVE') }
    })()`) as { regions: string[]; toastText: boolean }
    console.log('review', JSON.stringify(info))
    assert.equal(info.toastText, false, 'the visible toast "press LIVE to resume" is gone')
    assert.equal(info.regions.length, 1, `review mode is announced by one live region, got ${JSON.stringify(info.regions)}`)
  } finally {
    await page.context().close()
  }
})
