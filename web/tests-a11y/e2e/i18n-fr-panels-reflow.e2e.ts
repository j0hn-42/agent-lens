// French Conversation and Files panels at reflow sizes (#599, suite de #373; WCAG 1.4.10), measured in a real browser against
// the demo app (`pnpm --dir web run test:e2e`). The French labels of the header actions, the search, the pair filter and the
// file rows are longer than the English ones: at 320 px and at 1280 px / 200 % (a 640 x 512 window) nothing may scroll
// sideways, leave the window, be cut or sit on top of another button. The Context panel needs a relay (it is not available
// in demo mode), so its French states are covered by the jsdom test of the message catalog.
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

async function open(w: number, h: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  await context.addInitScript(() => { try { window.localStorage.setItem('agent-lens:locale', 'fr') } catch { /* blocked */ } })
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  await waitForStableLayout(page)
  return page
}

// A string so the TS transpiler injects no helper into the page.
const AUDIT = (selector: string) => `(() => {
  const root = document.querySelector(${JSON.stringify(selector)})
  if (!root) return { missing: true }
  const vw = document.documentElement.clientWidth, vh = window.innerHeight
  const rect = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const inside = r => r.l >= -0.5 && r.r <= vw + 0.5 && r.t >= -0.5 && r.b <= vh + 0.5
  const name = el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)
  const outside = [], cut = [], sticks = []
  const buttons = [...root.querySelectorAll('button')].filter(b => b.getClientRects().length > 0)
  for (const b of [root, ...buttons]) {
    if (!inside(rect(b))) outside.push(name(b) + ' ' + JSON.stringify(rect(b)))
    if (b.scrollWidth > b.clientWidth + 1) cut.push(name(b) + ' scroll ' + b.scrollWidth + ' > client ' + b.clientWidth)
  }
  const rr = rect(root)
  for (const e of root.querySelectorAll('*')) {
    if (e.getClientRects().length === 0 || e.closest('.sr-only')) continue
    // a row inside a scroller of its own (the message list, a long path) may be wider: only the panel box counts
    if (rect(e).r > rr.r + 1) sticks.push(name(e) + ' ' + JSON.stringify(rect(e)))
  }
  const overlap = []
  for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
    const a = rect(buttons[i]), c = rect(buttons[j])
    if (a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) overlap.push(name(buttons[i]) + ' / ' + name(buttons[j]))
  }
  return { missing: false, outside, cut, overlap, sticks, docScroll: document.documentElement.scrollWidth, vw }
})()`

interface Audit { missing: boolean; outside: string[]; cut: string[]; overlap: string[]; sticks: string[]; docScroll: number; vw: number }

async function expectFits(page: Page, selector: string, scenario: string) {
  const a = await page.evaluate(AUDIT(selector)) as Audit
  assert.ok(!a.missing, `[${scenario}] ${selector} is drawn`)
  assert.deepEqual(a.outside, [], `[${scenario}] nothing leaves the window`)
  assert.deepEqual(a.cut, [], `[${scenario}] no text is cut`)
  assert.deepEqual(a.overlap, [], `[${scenario}] no button covers another`)
  assert.deepEqual(a.sticks, [], `[${scenario}] nothing sticks out of the panel`)
  assert.ok(a.docScroll <= a.vw, `[${scenario}] no sideways scroll (${a.docScroll} > ${a.vw})`)
}

for (const [w, h] of [[320, 568], [640, 512]] as Array<[number, number]>) {
  test(`fr ${w}x${h}: the Conversation panel (header, search, pair filter) fits (#599)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h)
    try {
      await page.locator('body').press('c')
      const panel = page.locator('[data-dock-panel="conversation"]')
      await panel.waitFor()
      await panel.getByRole('button', { name: 'Exporter la conversation' }).waitFor()
      await waitForStableLayout(page)
      await expectFits(page, '[data-dock-panel="conversation"]', `${w}x${h} conversation`)
      await panel.getByRole('button', { name: 'Rechercher dans les messages' }).click()
      await panel.getByRole('searchbox', { name: 'Rechercher dans les messages' }).waitFor()
      const pair = panel.getByRole('button', { name: 'Filtrer une paire' }).first()
      if (await pair.count() > 0) await pair.click()
      await waitForStableLayout(page)
      await expectFits(page, '[data-dock-panel="conversation"]', `${w}x${h} conversation, search and pair filter open`)
    } finally {
      await page.context().close()
    }
  })

  test(`fr ${w}x${h}: the Files panel fits (#599)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h)
    try {
      await page.locator('body').press('f')
      const panel = page.locator('[data-dock-panel="files"]')
      await panel.waitFor()
      await panel.getByRole('region', { name: 'Fichiers consultés par les agents' }).waitFor()
      await waitForStableLayout(page)
      await expectFits(page, '[data-dock-panel="files"]', `${w}x${h} files`)
    } finally {
      await page.context().close()
    }
  })
}
