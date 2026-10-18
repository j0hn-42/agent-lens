// Settings in tabs (#533), measured in a real browser against the demo app (`pnpm --dir web run test:e2e`).
// Before #533 the dialog was one scroll of 1482 px at 1440x900. Now: each tab fits the screen from 768x1024 up (the dialog
// does not scroll), nothing scrolls sideways at 320 px nor at 640x512 (1280x1024 at 200 % zoom, WCAG 1.4.10) in English and in
// French, and the tab names wrap instead of overflowing. Arrow keys move between the tabs in the real browser too.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
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

async function openSettings(w: number, h: number, locale: 'en' | 'fr'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h } })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await waitForStableLayout(page)
  await page.locator('body').press(',')
  await page.getByRole('tablist').waitFor()
  return page
}

interface Fit { tab: string; dialogScroll: number; dialogClient: number; sideways: boolean; dialogSideways: boolean; tabOverflow: boolean }

/** Every tab in turn: does the dialog scroll, does anything overflow sideways. */
async function measureTabs(page: Page): Promise<Fit[]> {
  const out: Fit[] = []
  const count = await page.getByRole('tab').count()
  for (let i = 0; i < count; i++) {
    await page.getByRole('tab').nth(i).click()
    out.push(await page.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]')
      const tab = document.querySelector('[role="tab"][aria-selected="true"]')
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      return {
        tab: tab.textContent,
        dialogScroll: dialog.scrollHeight, dialogClient: dialog.clientHeight,
        sideways: document.documentElement.scrollWidth > window.innerWidth,
        dialogSideways: dialog.scrollWidth > dialog.clientWidth,
        tabOverflow: tabs.some(t => t.scrollWidth > t.clientWidth + 1),
      }
    })()`) as Fit)
  }
  return out
}

for (const locale of ['en', 'fr'] as const) {
  for (const [w, h] of [[1440, 900], [1024, 768], [768, 1024]] as const) {
    test(`${locale} ${w}x${h}: every tab fits the screen, the dialog does not scroll`, async () => {
      const page = await openSettings(w, h, locale)
      for (const m of await measureTabs(page)) {
        assert.ok(m.dialogScroll <= m.dialogClient + 1, `${m.tab}: ${m.dialogScroll} px of content in ${m.dialogClient} px`)
        assert.ok(!m.sideways && !m.dialogSideways && !m.tabOverflow, `${m.tab}: nothing overflows sideways`)
      }
      await page.context().close()
    })
  }
  for (const [w, h] of [[390, 844], [320, 568], [640, 512]] as const) {
    test(`${locale} ${w}x${h}: no sideways scroll in any tab, tab names wrap (WCAG 1.4.10)`, async () => {
      const page = await openSettings(w, h, locale)
      for (const m of await measureTabs(page)) {
        assert.equal(m.sideways, false, `${m.tab}: the page scrolls sideways`)
        assert.equal(m.dialogSideways, false, `${m.tab}: the dialog scrolls sideways`)
        assert.equal(m.tabOverflow, false, `${m.tab}: a tab name is cut`)
      }
      await page.context().close()
    })
  }
}

test('arrow keys move between tabs and the focus stays visible on the selected tab', async () => {
  const page = await openSettings(1024, 768, 'en')
  assert.equal(await page.evaluate(`document.activeElement.getAttribute('role')`), 'tab', 'the selected tab has the focus on open')
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(`document.activeElement.textContent`), 'Sessions and presentation')
  assert.equal(await page.getByRole('tab', { selected: true }).textContent(), 'Sessions and presentation')
  await page.keyboard.press('End')
  assert.equal(await page.getByRole('tab', { selected: true }).textContent(), 'Keyboard and preferences')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(`!!document.activeElement.closest('[role="tabpanel"]')`), true, 'Tab goes from the tab to its panel')
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.context().close()
})
