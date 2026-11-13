// The Burrow view in a real browser (`pnpm --dir web run test:e2e`): switched on through the saved preferences
// ('agent-lens:ui-prefs' { v: 1, prefs: { sceneStyle: 'burrow' } }), it replaces the node graph with a named region
// whose canvas is really drawn (the pixel-art pictures loaded and painted, which jsdom cannot show), and axe finds
// nothing in it. The jsdom side (Tab order, Enter, no animation frame under reduced motion) is in
// tests-a11y/burrow-mounted.test.tsx.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
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

async function openBurrow(reducedMotion: 'reduce' | 'no-preference' = 'no-preference') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion })
  await context.addInitScript(() => {
    if (window.localStorage.getItem('agent-lens:ui-prefs') === null) {
      window.localStorage.setItem('agent-lens:ui-prefs', JSON.stringify({ v: 1, prefs: { sceneStyle: 'burrow' } }))
    }
  })
  const page = await context.newPage()
  await page.goto(server.url)
  return { page, close: () => context.close() }
}

/** Opaque pixels of the burrow canvas: the floor and the walls are drawn once the pictures are loaded */
const PAINTED = `(() => {
  const c = document.querySelector('[role="region"] canvas')
  if (!c || !c.width || !c.height) return 0
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++
  return n / (c.width * c.height)
})()`

test('the saved Burrow preference shows a named region whose canvas is drawn, in place of the graph', async () => {
  const { page, close } = await openBurrow()
  try {
    const region = page.getByRole('region', { name: 'Burrow: one animal per agent, one room per kind of work' })
    await region.waitFor({ timeout: 30_000 })
    const canvas = region.locator('canvas')
    await canvas.waitFor()
    // the picture is painted (a blank canvas is all transparent): a good part of it is covered
    await page.waitForFunction(PAINTED, undefined, { timeout: 30_000, polling: 250 })
    const share = await page.evaluate(PAINTED) as number
    assert.ok(share > 0.25, `the burrow canvas is painted (${(share * 100).toFixed(0)}% of its pixels)`)
    const box = await canvas.boundingBox()
    assert.ok(box && box.width > 100 && box.height > 50, `the canvas has a visible size (${JSON.stringify(box)})`)
    // the loading message is gone and no failure is shown
    assert.equal(await page.getByRole('button', { name: 'Back to the graph' }).count(), 0)
    // the controls of the burrow are named
    await region.getByRole('button', { name: 'Room titles' }).waitFor()
    await region.getByRole('button', { name: 'Legend' }).waitFor()
  } finally {
    await close()
  }
})

test('axe finds no violation in the burrow region, under reduced motion too', async () => {
  for (const motion of ['no-preference', 'reduce'] as const) {
    const { page, close } = await openBurrow(motion)
    try {
      const region = page.getByRole('region', { name: 'Burrow: one animal per agent, one room per kind of work' })
      await region.waitFor({ timeout: 30_000 })
      await page.waitForFunction(PAINTED, undefined, { timeout: 30_000, polling: 250 })
      const results = await new AxeBuilder({ page })
        .include('[role="region"][aria-label^="Burrow"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      assert.deepEqual(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), [], `[${motion}]`)
    } finally {
      await close()
    }
  }
})
