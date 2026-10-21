// Real-browser checks of presentation mode (#245): the badge and the masking are real in CSS (blur, no selection),
// the badge does not cover the top bar, no new serious axe violation with the mode on, and the mode stops with V.
// Runs against the demo app (see demo-server.ts).
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
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

async function open(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto(server.url)
  await page.getByRole('button', { name: 'Files' }).waitFor()
  await waitForStableLayout(page)
  return { page, close: () => context.close() }
}

const FILTER = `(() => { const el = document.querySelector('[data-dock-panel="files"]'); const cs = getComputedStyle(el); return { filter: cs.filter, select: cs.userSelect } })()`

test('e2e: V masks the Files panel (blur, no selection) and a second V clears it', async () => {
  const { page, close } = await open()
  try {
    await page.getByRole('button', { name: 'Files' }).first().click()
    await waitForStableLayout(page)
    const before = await page.evaluate(FILTER) as { filter: string; select: string }
    assert.equal(before.filter, 'none', 'not blurred outside presentation mode')
    // Letter shortcuts are ignored while a button or a dialog has the focus
    await page.evaluate('document.activeElement && document.activeElement.blur()')
    await page.keyboard.press('v')
    await page.getByRole('button', { name: 'Presentation mode · V to stop' }).waitFor()
    const during = await page.evaluate(FILTER) as { filter: string; select: string }
    assert.match(during.filter, /blur\(/)
    assert.equal(during.select, 'none')
    await page.keyboard.press('v')
    assert.equal(await page.getByRole('button', { name: 'Presentation mode · V to stop' }).count(), 0)
    assert.equal(((await page.evaluate(FILTER)) as { filter: string }).filter, 'none')
  } finally { await close() }
})

test('e2e: the badge sits below the top bar and inside the viewport, and is reachable by Tab', async () => {
  const { page, close } = await open()
  try {
    await page.keyboard.press('v')
    const badge = page.getByRole('button', { name: 'Presentation mode · V to stop' })
    await badge.waitFor()
    const [b, bar] = await Promise.all([
      badge.boundingBox(),
      page.locator('header, [role="banner"]').first().boundingBox(),
    ])
    assert.ok(b && bar)
    assert.ok(b!.y >= bar!.y + bar!.height - 1, `badge (${b!.y}) starts below the top bar (${bar!.y + bar!.height})`)
    assert.ok(b!.x >= 0 && b!.x + b!.width <= 1280)
    await badge.focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.getByRole('button', { name: 'Presentation mode · V to stop' }).count(), 0, 'Enter on the badge stops the mode')
  } finally { await close() }
})

test('e2e: no new serious or critical axe violation with presentation mode on', async () => {
  const { page, close } = await open()
  try {
    await page.keyboard.press('v')
    await page.getByRole('button', { name: 'Presentation mode · V to stop' }).waitFor()
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
    const { unexpected } = compareViolations('e2e:initial page', serious.map(v => v.id), known)
    assert.deepEqual(unexpected, [])
  } finally { await close() }
})
