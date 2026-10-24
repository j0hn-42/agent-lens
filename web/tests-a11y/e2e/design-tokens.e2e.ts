// Real-browser check of the design tokens of #509: the text-2xs utility renders at 11 px (the size of the
// text-[11px] it replaced), also at 200 % zoom, in every element of the demo that carries it; the z-(--z-info)
// utility resolves to the info level of Z; the scrim token is the theme's.
//
//   pnpm --dir web run test:e2e
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { Z } from '@/lib/agent-types'

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

async function open(page: Page) {
  await page.goto(server.url)
  await page.locator('header').first().waitFor({ timeout: 120_000 })
}

/** Computed font sizes of every element carrying text-2xs, plus a probe element that carries it for sure. */
const sizes = (page: Page) => page.evaluate(`(() => {
  const probe = document.createElement('span'); probe.className = 'text-2xs'; probe.textContent = 'probe'; document.body.appendChild(probe)
  const all = [...document.querySelectorAll('.text-2xs')].map(el => getComputedStyle(el).fontSize)
  const out = { probe: getComputedStyle(probe).fontSize, count: all.length, distinct: [...new Set(all)] }
  probe.remove()
  return out
})()`) as Promise<{ probe: string; count: number; distinct: string[] }>

for (const [label, scale, width] of [['100 %', 1, 1280], ['200 % zoom', 2, 640]] as const) {
  test(`text-2xs computes to 11px at ${label}, in the probe and in every element of the demo`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: scale })
    const page = await context.newPage()
    try {
      await open(page)
      const s = await sizes(page)
      assert.equal(s.probe, '11px')
      assert.ok(s.count > 0, 'the demo shows at least one text-2xs element')
      assert.deepEqual(s.distinct, ['11px'])
    } finally {
      await context.close()
    }
  })
}

test('z-(--z-info) resolves to the info level of Z, and --lens-scrim is defined by the theme', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  try {
    await open(page)
    const r = await page.evaluate(`(() => {
      const el = document.createElement('div'); el.className = 'relative z-(--z-info)'; document.body.appendChild(el)
      const z = getComputedStyle(el).zIndex
      el.remove()
      return { z, scrim: getComputedStyle(document.documentElement).getPropertyValue('--lens-scrim').trim() }
    })()`) as { z: string; scrim: string }
    assert.equal(r.z, String(Z.info))
    assert.ok(r.scrim.length > 0, 'the theme defines --lens-scrim')
  } finally {
    await context.close()
  }
})
