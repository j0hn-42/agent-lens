// #380 (1.4.3): the axe `color-contrast` rule, in a real browser, for every theme (THEME_IDS). jsdom cannot compute
// contrast (the rule is off in axe.test.tsx) and demo.e2e.ts only checks the default theme. This audits the initial
// page (top bar) only; popups and panels are not opened. Runs against the demo app:
//
//   pnpm --dir web run test:e2e
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { THEME_IDS } from '@/lib/theme-tokens'

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

/** Switch the theme through the Settings dialog, then close the dialog so only the page chrome is audited. */
async function setTheme(page: Page, id: string) {
  const select = page.getByRole('combobox', { name: 'Theme' })
  if (!(await select.isVisible())) await page.getByRole('button', { name: 'Settings' }).click()
  await select.waitFor()
  await select.selectOption(id)
  await page.keyboard.press('Escape')
  await select.waitFor({ state: 'hidden' })
}

type ContrastData = { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string; messageKey?: string }

/**
 * Incomplete results axe may leave, each with the reason it is harmless. Anything else incomplete means axe could not
 * compute a contrast (e.g. text over the canvas bitmap) and the audit would pass without checking it.
 */
const INCOMPLETE_ALLOWED: Record<string, string> = {
  // a decorative glyph (emoji icon in an aria-hidden span): axe reports "only non-text characters", no text to contrast
  nonBmp: 'non-text characters',
}

async function contrastAudit(page: Page) {
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
  const describe = (n: { target: unknown[]; any: { data?: unknown }[] }) => {
    const data = (n.any[0]?.data ?? {}) as ContrastData
    return `${n.target.join(' ')} fg ${data.fgColor} bg ${data.bgColor} ratio ${data.contrastRatio} (needs ${data.expectedContrastRatio})${data.messageKey ? ` [${data.messageKey}]` : ''}`
  }
  return {
    failures: results.violations.flatMap(v => v.nodes.map(describe)),
    passes: results.passes.reduce((sum, r) => sum + r.nodes.length, 0),
    unexplained: results.incomplete.flatMap(r => r.nodes)
      .filter(n => !Object.hasOwn(INCOMPLETE_ALLOWED, (n.any[0]?.data as ContrastData | undefined)?.messageKey ?? ''))
      .map(describe),
  }
}

for (const id of THEME_IDS) {
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
      const { failures, passes, unexplained } = await contrastAudit(page)
      assert.deepEqual(failures, [], `[${id}] color-contrast violations`)
      assert.deepEqual(unexplained, [], `[${id}] nodes axe could not evaluate`)
      assert.ok(passes > 0, `[${id}] axe checked no text node: the audit would pass empty`)
    } finally { await context.close() }
  })
}
