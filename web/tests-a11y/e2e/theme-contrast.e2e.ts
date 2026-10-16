// #380 (1.4.3): the axe `color-contrast` rule, in a real browser, for each of the nine themes. jsdom cannot compute
// contrast (the rule is off in axe.test.tsx) and demo.e2e.ts only checks the default theme, so a theme-specific
// failure (e.g. "Result:" at 3.88:1 in Anthropic) went unseen. Runs against the demo app:
//
//   pnpm --dir web run test:e2e
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
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

const THEMES = ['catppuccin-macchiato', 'graphite', 'midnight', 'ember', 'anthropic', 'contrast', 'catppuccin-mocha', 'catppuccin-frappe', 'neon'] as const

/** Switch the theme through the Settings dialog, then close the dialog so only the page chrome is audited. */
async function setTheme(page: Page, id: string) {
  const select = page.getByRole('combobox', { name: 'Theme' })
  if (!(await select.isVisible())) await page.getByRole('button', { name: 'Settings' }).click()
  await select.waitFor()
  await select.selectOption(id)
  await page.keyboard.press('Escape')
  await select.waitFor({ state: 'hidden' })
}

async function contrastFailures(page: Page) {
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
  return results.violations.flatMap(v => v.nodes.map(n => {
    const data = (n.any[0]?.data ?? {}) as { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string }
    return `${n.target.join(' ')} fg ${data.fgColor} bg ${data.bgColor} ratio ${data.contrastRatio} (needs ${data.expectedContrastRatio})`
  }))
}

for (const id of THEMES) {
  test(`e2e: color-contrast, theme ${id}`, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    try {
      await page.goto(server.url)
      await page.getByRole('button', { name: 'Files' }).waitFor()
      await waitForStableLayout(page)
      await setTheme(page, id)
      await waitForStableLayout(page)
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), id)
      assert.deepEqual(await contrastFailures(page), [], `[${id}] color-contrast violations`)
    } finally { await context.close() }
  })
}
