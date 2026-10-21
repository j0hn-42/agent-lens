// French chrome at reflow sizes (#590, after #586 #587 #588; WCAG 1.4.10), measured in a real browser against the demo app
// (`pnpm --dir web run test:e2e`). The French texts of the playback bar (review mode with its clear confirmation open), of
// the canvas context menu (armed, next to the right edge) and of the shortcuts dialog are longer than the English ones:
// at 320 px and at 1280 px / 200 % (a 640 x 512 window) nothing may scroll sideways, leave the window or be cut.
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

// A string so the TS transpiler injects no helper into the page. Lists the buttons (and the container itself) that leave
// the window or are cut by their own box, and the pairs of buttons that overlap.
const AUDIT = (selector: string) => `(() => {
  const root = document.querySelector(${JSON.stringify(selector)})
  if (!root) return { missing: true }
  const vw = document.documentElement.clientWidth, vh = window.innerHeight
  const rect = el => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const inside = r => r.l >= -0.5 && r.r <= vw + 0.5 && r.t >= -0.5 && r.b <= vh + 0.5
  const name = el => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)
  const outside = [], cut = []
  const buttons = [...root.querySelectorAll('button')].filter(b => b.getClientRects().length > 0)
  for (const b of [root, ...buttons]) {
    if (!inside(rect(b))) outside.push(name(b) + ' ' + JSON.stringify(rect(b)))
    if (b.scrollWidth > b.clientWidth + 1) cut.push(name(b) + ' scroll ' + b.scrollWidth + ' > client ' + b.clientWidth)
  }
  const overlap = []
  for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
    const a = rect(buttons[i]), c = rect(buttons[j])
    if (a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) overlap.push(name(buttons[i]) + ' / ' + name(buttons[j]))
  }
  return { missing: false, outside, cut, overlap, docScroll: document.documentElement.scrollWidth, vw }
})()`

interface Audit { missing: boolean; outside: string[]; cut: string[]; overlap: string[]; docScroll: number; vw: number }

async function expectFits(page: Page, selector: string, scenario: string) {
  const a = await page.evaluate(AUDIT(selector)) as Audit
  assert.ok(!a.missing, `[${scenario}] ${selector} is drawn`)
  assert.deepEqual(a.outside, [], `[${scenario}] nothing leaves the window`)
  assert.deepEqual(a.cut, [], `[${scenario}] no text is cut`)
  assert.deepEqual(a.overlap, [], `[${scenario}] no button covers another`)
  assert.ok(a.docScroll <= a.vw, `[${scenario}] no sideways scroll (${a.docScroll} > ${a.vw})`)
}

for (const [w, h] of [[320, 568], [640, 512]] as Array<[number, number]>) {
  test(`fr ${w}x${h}: the review bar with its clear confirmation open fits (#590)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h)
    try {
      await page.getByRole('button', { name: /Revue/ }).click()
      const clear = page.getByRole('button', { name: 'Effacer l’historique', exact: true })
      await clear.waitFor()
      await waitForStableLayout(page)
      await expectFits(page, '[data-control-bar]', `${w}x${h} review`)
      await clear.click()
      await page.getByRole('button', { name: /Annuler/ }).waitFor()
      await waitForStableLayout(page)
      await expectFits(page, '[data-control-bar]', `${w}x${h} review, confirmation open`)
    } finally {
      await page.context().close()
    }
  })

  test(`fr ${w}x${h}: the armed context menu next to the right edge stays inside the window (#590)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h)
    try {
      // Four pixels from the right edge of the window, on the empty canvas: the menu has to be pushed back inside. Half way
      // down first; an agent drawn there (the one-line top bar leaves the canvas taller) opens the agent menu instead, so
      // lower, then higher
      const clear = page.getByRole('menuitem', { name: 'Effacer l’historique' })
      for (const y of [0.5, 0.7, 0.3].map(f => Math.round(h * f))) {
        await page.mouse.click(w - 4, y, { button: 'right' })
        await page.getByRole('menu').waitFor()
        if (await clear.count() > 0) break
        await page.keyboard.press('Escape')
        await page.getByRole('menu').waitFor({ state: 'detached' })
      }
      await expectFits(page, '[role="menu"]', `${w}x${h} menu`)
      await page.getByRole('menuitem', { name: 'Effacer l’historique' }).click()
      await page.getByRole('menuitem', { name: 'Confirmer l’effacement de l’historique' }).waitFor()
      await waitForStableLayout(page)
      await expectFits(page, '[role="menu"]', `${w}x${h} menu armed`)
    } finally {
      await page.context().close()
    }
  })

  test(`fr ${w}x${h}: the shortcuts dialog fits (#590)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h)
    try {
      await page.locator('body').press('?')
      await page.getByRole('dialog', { name: /raccourcis/i }).waitFor()
      await waitForStableLayout(page)
      const a = await page.evaluate(`(() => {
        const d = document.querySelector('[role="dialog"][aria-modal="true"]')
        const r = d.getBoundingClientRect()
        // the content may scroll vertically inside the dialog, never sideways
        const wide = [...d.querySelectorAll('*')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > r.right + 1).map(e => (e.textContent || '').trim().slice(0, 30))
        return { l: r.left, r: r.right, vw: document.documentElement.clientWidth, sx: d.scrollWidth - d.clientWidth, wide, docScroll: document.documentElement.scrollWidth }
      })()`) as { l: number; r: number; vw: number; sx: number; wide: string[]; docScroll: number }
      assert.ok(a.l >= -0.5 && a.r <= a.vw + 0.5, `the dialog is inside the window (${a.l}-${a.r} of ${a.vw})`)
      assert.ok(a.sx <= 1, `the dialog does not scroll sideways (${a.sx})`)
      assert.deepEqual(a.wide, [], 'no row sticks out of the dialog')
      assert.ok(a.docScroll <= a.vw, 'no sideways scroll of the page')
    } finally {
      await page.context().close()
    }
  })
}
