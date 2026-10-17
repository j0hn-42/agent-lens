// Mobile view (#476, #241 PR 4), measured in a real browser against the demo app (`pnpm --dir web run test:e2e`).
// At 375x667: the chrome controls are drawn at least 44x44 px, an open panel is a drawer (focus moved in, kept
// in by Tab, given back on close), zoom and fit buttons stand in for pinch and drag, touch-action: none stays on the
// canvas, nothing scrolls sideways at 320 px, landscape works and reduced motion stops the drawer's slide.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { compareViolations, type KnownViolation } from '../axe-compare'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'

const known: KnownViolation[] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'known-violations.json'), 'utf8'))

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

async function open(w: number, h: number, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, ...options })
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^More/ }).waitFor()
  await waitForStableLayout(page)
  return page
}

/** axe on the whole page, serious and critical, against the shared allow-list (never widened here). */
async function expectClean(page: Page, scenario: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
  const { unexpected } = compareViolations(scenario, serious.map(v => v.id), known)
  assert.deepEqual(unexpected, [], `[${scenario}] serious/critical axe violations: ${serious.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`).join('; ')}`)
}

const noHorizontalScroll = (page: Page) => page.evaluate('document.documentElement.scrollWidth <= window.innerWidth') as Promise<boolean>

/** Rendered controls under `selector` (buttons, sliders, selects) with their drawn size. */
async function controls(page: Page, selector: string): Promise<Array<{ name: string; w: number; h: number }>> {
  return page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .filter(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !el.closest('.sr-only') })
    .map(el => { const r = el.getBoundingClientRect(); return { name: el.getAttribute('aria-label') || el.textContent.trim(), w: r.width, h: r.height } })`) as Promise<Array<{ name: string; w: number; h: number }>>
}

function expectTargets(list: Array<{ name: string; w: number; h: number }>, where: string) {
  assert.ok(list.length > 0, `${where}: controls found`)
  for (const c of list) assert.ok(c.w >= 44 - 0.01 && c.h >= 44 - 0.01, `${where}: "${c.name}" is ${c.w.toFixed(1)}x${c.h.toFixed(1)} px (44x44 needed)`)
}

const CHROME_TARGETS = {
  'top bar': 'header button, header select',
  'zoom block': '[role="group"][aria-label="Zoom"] button',
  'canvas controls': '[aria-controls="graph-legend-panel"], button[aria-haspopup="dialog"][aria-expanded]',
  'playback bar': '[data-control-bar] button, [data-control-bar] [role="slider"]',
} as const

const focusInside = (page: Page, selector: string) => page.evaluate(`!!document.activeElement && !!document.activeElement.closest(${JSON.stringify(selector)})`) as Promise<boolean>

test('375x667: the folded top bar is short and every chrome control is at least 44x44 px', async () => {
  const page = await open(375, 667)
  try {
    const bar = (await page.locator('header').boundingBox())!
    assert.ok(bar.height <= 130, `the folded top bar is ${bar.height} px high (budget 130)`)
    for (const [where, selector] of Object.entries(CHROME_TARGETS)) expectTargets(await controls(page, selector), where)
    assert.ok(await noHorizontalScroll(page), 'no horizontal page scroll')
    await expectClean(page, 'e2e:mobile-folded-375')

    const more = page.locator('header').getByRole('button', { name: /^More/ })
    await more.click()
    assert.equal(await more.getAttribute('aria-expanded'), 'true')
    expectTargets(await controls(page, CHROME_TARGETS['top bar']), 'top bar expanded')
    assert.ok(await page.getByRole('button', { name: 'Files', exact: true }).isVisible(), 'More shows the panel buttons')
    assert.ok(await noHorizontalScroll(page), 'expanded: no horizontal page scroll')
    // Taller than the window, the expanded bar scrolls inside itself instead of running off the screen
    const grown = (await page.locator('header').boundingBox())!
    assert.ok(grown.y + grown.height <= 667 + 0.5, `the expanded bar ends at ${grown.y + grown.height}, inside the window`)
    await expectClean(page, 'e2e:mobile-expanded-375')
  } finally {
    await page.context().close()
  }
})

test('375x667: Sessions opens a drawer; Tab stays inside, Escape closes it and gives the focus back', async () => {
  const page = await open(375, 667)
  try {
    const sessions = page.locator('header').getByRole('button', { name: /^Sessions/ })
    await sessions.focus()
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('dialog', { name: /Sessions/i })
    await drawer.waitFor()
    // Not aria-modal: the permission cards and the truncation notice above it stay in reach (#410, #453)
    assert.equal(await drawer.getAttribute('aria-modal'), null)
    await page.waitForFunction(`!!document.activeElement && !!document.activeElement.closest('[data-mobile-drawer]')`)
    const box = (await drawer.boundingBox())!
    assert.ok(box.x >= 0 && box.x + box.width <= 375 + 0.5 && box.width >= 375 - 16 - 1, `the drawer spans the width (${box.x}, ${box.width})`)
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab')
      assert.ok(await focusInside(page, '[data-mobile-drawer]'), `Tab ${i + 1} left the drawer`)
    }
    expectTargets(await controls(page, '[data-mobile-drawer] [data-panel-close]'), 'drawer Close')
    assert.ok(await noHorizontalScroll(page), 'drawer open: no horizontal page scroll')
    await expectClean(page, 'e2e:mobile-drawer-sessions-375')
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'detached' }).catch(() => drawer.waitFor({ state: 'hidden' }))
    assert.equal(await page.getByRole('dialog').count(), 0, 'the drawer is closed')
    assert.equal(await page.evaluate(`document.activeElement && document.activeElement.id`), 'topbar-toggle-sessions', 'the focus is back on Sessions')
  } finally {
    await page.context().close()
  }
})

test('375x667: Files from More opens below the bars, More folds, closing gives the focus to More', async () => {
  const page = await open(375, 667)
  try {
    const more = page.locator('header').getByRole('button', { name: /^More/ })
    await more.click()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'Files' })
    await drawer.waitFor()
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'More folded again')
    await page.waitForFunction(`!!document.activeElement && !!document.activeElement.closest('[data-mobile-drawer]')`)
    await waitForStableLayout(page)
    const d = (await drawer.boundingBox())!
    const top = (await page.locator('header').boundingBox())!
    const bar = (await page.locator('[data-control-bar]').first().boundingBox())!
    assert.ok(d.y >= top.y + top.height - 0.5, `the drawer starts at ${d.y}, under the top bar ending at ${top.y + top.height}`)
    assert.ok(d.y + d.height <= bar.y + 0.5, `the drawer ends at ${d.y + d.height}, above the playback bar at ${bar.y}`)
    await page.locator('[data-mobile-drawer] [data-panel-close]').click()
    await page.waitForFunction(`!document.querySelector('[data-mobile-drawer]')`)
    assert.equal(await page.evaluate(`document.activeElement && document.activeElement.id`), 'topbar-more', 'the focus is on More (the Files button is folded)')
  } finally {
    await page.context().close()
  }
})

test('375x667: zoom in, zoom out and fit change the view without a gesture (2.5.1)', async () => {
  const page = await open(375, 667)
  try {
    const canvas = page.locator('[role="img"] canvas').first()
    const shot = async () => (await canvas.screenshot()).toString('base64')
    const before = await shot()
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await page.waitForTimeout(600)
    assert.notEqual(await shot(), before, 'Zoom in redraws the canvas')
    for (const name of ['Zoom out', 'Fit to view']) {
      const b = page.getByRole('button', { name, exact: true })
      assert.ok(await b.isVisible(), `${name} is offered`)
      await b.click()
    }
  } finally {
    await page.context().close()
  }
})

test('375x667: touch-action: none is on the canvas (and its edge bubbles), never on the page or the panels', async () => {
  const page = await open(375, 667)
  try {
    await page.getByRole('button', { name: /^Sessions/ }).click()
    await page.getByRole('dialog').waitFor()
    const offenders = await page.evaluate(`[...document.querySelectorAll('*')]
      .filter(el => getComputedStyle(el).touchAction === 'none')
      .filter(el => !(el.tagName === 'CANVAS' && el.closest('[role="img"]')) && !el.closest('[data-edge-bubble-layer]')
        && !(el.getAttribute('role') === 'slider' && el.closest('[data-control-bar]')))
      .map(el => el.tagName + (el.id ? '#' + el.id : '') + '.' + String(el.className).slice(0, 60))`) as string[]
    assert.deepEqual(offenders, [], 'touch-action: none outside the canvas')
    for (const sel of ['html', 'body', 'header', '[data-mobile-drawer]']) {
      assert.notEqual(await page.locator(sel).first().evaluate(el => getComputedStyle(el).touchAction), 'none', `${sel} keeps the browser's own gestures`)
    }
  } finally {
    await page.context().close()
  }
})

for (const [w, h] of [[320, 568], [667, 375]] as Array<[number, number]>) {
  test(`${w}x${h}: no horizontal scroll, folded, expanded and with a drawer open (1.4.10, 1.3.4)`, async () => {
    const page = await open(w, h)
    try {
      assert.ok(await noHorizontalScroll(page), 'folded')
      const more = page.locator('header').getByRole('button', { name: /^More/ })
      await more.click()
      assert.ok(await noHorizontalScroll(page), 'expanded')
      await more.click()
      await page.getByRole('button', { name: /^Sessions/ }).click()
      await page.getByRole('dialog').waitFor()
      assert.ok(await noHorizontalScroll(page), 'drawer open')
    } finally {
      await page.context().close()
    }
  })
}

test('375x667, reduced motion: the drawer appears without sliding', async () => {
  const page = await open(375, 667, { reducedMotion: 'reduce' })
  try {
    await page.getByRole('button', { name: /^Sessions/ }).click()
    const drawer = page.locator('[data-mobile-drawer]')
    await drawer.waitFor()
    const duration = await drawer.evaluate(el => getComputedStyle(el).transitionDuration)
    // globals.css shortens every transition to 0.01 ms under reduced motion; the drawer also has motion-reduce:transition-none
    assert.ok(duration.split(',').every(d => parseFloat(d) <= 0.001), `transition-duration is ${duration}`)
  } finally {
    await page.context().close()
  }
})

// #523: the top bar folds behind More under 1024 px, but the mobile branches (drawers, 44 px targets) stay under 768 px
test('768x900: the bar is folded behind More, the mobile branches are off (no drawer, no 44 px target)', async () => {
  const context = await browser.newContext({ viewport: { width: 768, height: 900 } })
  const page = await context.newPage()
  try {
    await page.goto(server.url, { waitUntil: 'networkidle' })
    const more = page.locator('header').getByRole('button', { name: /^More/ })
    await more.waitFor()
    assert.equal(await more.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('header').getByRole('button', { name: 'Commands', exact: true }).count(), 1, 'Commands stays in the folded bar from 768 px')
    assert.ok((await more.boundingBox())!.height < 44, 'no 44 px target at 768 px')
    await page.getByRole('button', { name: /^Sessions/ }).click()
    await page.locator('#sessions-panel').waitFor()
    assert.equal(await page.locator('[data-mobile-drawer]').count(), 0)
  } finally {
    await context.close()
  }
})
