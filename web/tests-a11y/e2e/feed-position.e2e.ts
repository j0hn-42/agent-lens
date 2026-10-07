// Real-layout check for the message feed position (issue #12, D4): the pill / panel use FEED_TOP, which
// must clear a top bar that wraps onto several rows. Self-contained (no dev server): a fake bar publishes
// --topbar-h exactly like the shell does, and the feed wrapper is positioned with the exported expression.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser } from 'playwright'
import { FEED_TOP } from '../../lib/feed-utils'

let browser: Browser | null = null
before(async () => {
  try { browser = await chromium.launch() } catch (err) {
    if (process.env.CI) throw err
  }
})
after(async () => { await browser?.close() })

const VIEWPORTS: Array<[number, number, number]> = [[1600, 900, 14], [1024, 768, 9], [390, 844, 5]]

for (const [width, height, items] of VIEWPORTS) {
  test(`feed pill never overlaps a wrapped top bar at ${width}x${height}`, async (t) => {
    if (!browser) return t.skip('chromium not available')
    const page = await browser.newPage({ viewport: { width, height } })
    try {
      await page.setContent(`<!doctype html><body style="margin:0;position:relative;height:100vh">
        <header id="bar" style="position:absolute;top:0;left:0;right:0;display:flex;flex-wrap:wrap;gap:8px;padding:8px 12px">
          ${Array.from({ length: items }, (_, i) => `<span style="min-width:150px;height:28px;display:inline-block">c${i}</span>`).join('')}
        </header>
        <div id="feed" style="position:absolute;left:12px;top:${FEED_TOP}"><button style="height:32px;width:300px">pill</button></div>
      </body>`)
      // the shell's job: publish the measured height
      await page.evaluate(() => {
        const bar = document.getElementById('bar')!
        document.documentElement.style.setProperty('--topbar-h', `${bar.getBoundingClientRect().height}px`)
      })
      const { bar, feed } = await page.evaluate(() => ({
        bar: document.getElementById('bar')!.getBoundingClientRect().toJSON(),
        feed: document.getElementById('feed')!.getBoundingClientRect().toJSON(),
      }))
      assert.ok(bar.height > 48, `top bar should have wrapped (height ${bar.height})`)
      assert.ok(feed.top >= bar.bottom, `feed top ${feed.top} overlaps bar bottom ${bar.bottom}`)
    } finally {
      await page.close()
    }
  })
}
