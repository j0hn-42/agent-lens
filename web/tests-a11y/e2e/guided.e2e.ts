// The guided tour end to end, in a real browser: walks every step and checks that the card and the ring show.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { GUIDED_STEPS } from '../../lib/guided-steps'

let browser: Browser
let server: DemoServer

/** Names of the agents listed in the accessible graph outline (the agents the canvas draws) */
const outlineAgentNames = (page: Page) => page.locator('section[aria-label="Agent graph outline"] button[data-graph-node]')
  .evaluateAll(buttons => buttons.map(b => (b.textContent ?? '').split(',')[0].trim()))

before(async () => { server = await startDemoServer(); browser = await chromium.launch() }, { timeout: 240_000 })
after(async () => { await browser?.close(); await server?.stop() })

test('the guided tour walks every step with Next and shows the card each time', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  for (let i = 0; i < GUIDED_STEPS.length; i++) {
    await page.getByText(`Step ${i + 1} of ${GUIDED_STEPS.length}`).waitFor()
    assert.ok(await dialog.getByRole('heading', { name: GUIDED_STEPS[i].title }).isVisible(), `step ${i + 1}: ${GUIDED_STEPS[i].title}`)
    // Every step target is on screen at its time: a misnamed agent or a missing DOM target would leave no ring
    const ring = page.locator('[data-tour-ring]')
    await ring.waitFor({ timeout: 5_000 })
    // ...and once the camera has settled, in the viewport and not hidden under the card
    await page.waitForTimeout(1_500)
    const r = (await ring.boundingBox())!
    const c = (await dialog.boundingBox())!
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1280 && r.y + r.height <= 800, `step ${i + 1}: ring out of view`)
    assert.ok(r.y + r.height <= c.y || r.x + r.width <= c.x || r.x >= c.x + c.width, `step ${i + 1}: ring under the card`)
    // An agent step targets an agent that is drawn: a hidden agent (Hide inactive agents) is not in the outline
    const target = GUIDED_STEPS[i].target
    if (target.kind === 'agent') {
      assert.ok(await ring.isVisible(), `step ${i + 1}: ring visible`)
      const names = await outlineAgentNames(page)
      assert.ok(names.includes(target.name), `step ${i + 1}: ${target.name} is in the graph outline (${names.join(' | ')})`)
    }
    if (i < GUIDED_STEPS.length - 1) await dialog.getByRole('button', { name: 'Next' }).click()
  }
  assert.equal(await dialog.getByRole('button', { name: 'Next' }).isDisabled(), true)
  await dialog.getByRole('button', { name: 'Previous' }).click()
  await page.getByText(`Step ${GUIDED_STEPS.length - 1} of ${GUIDED_STEPS.length}`).waitFor()
})

test('legend steps open the legend and leave the saved preference alone', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  await page.getByRole('dialog').waitFor()
  const discoveries = GUIDED_STEPS.findIndex(s => s.opensLegend)
  await page.getByRole('combobox', { name: 'Go to step' }).selectOption(String(discoveries))
  await page.getByRole('region', { name: 'Graph legend' }).waitFor()
  assert.equal(await page.evaluate(() => window.localStorage.getItem('agent-viz-legend-open')), null)
  // The tour also shows the idle and finished agents it talks about without saving 'Hide inactive agents'
  assert.equal(await page.evaluate(() => window.localStorage.getItem('agent-lens:hide-inactive-agents')), null)
})

test('the tour shows inactive agents without changing the saved Hide inactive agents preference', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(() => { if (window.localStorage.getItem('agent-lens:hide-inactive-agents') === null) window.localStorage.setItem('agent-lens:hide-inactive-agents', 'true') })
  const page = await context.newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const stored = () => page.evaluate(() => window.localStorage.getItem('agent-lens:hide-inactive-agents'))
  const hideToggle = page.getByRole('button', { name: 'Hide inactive agents' })
  assert.equal(await stored(), 'true')
  // The team step targets api-dev while it is idle: shown by the tour, while the toggle still reflects the preference
  const team = GUIDED_STEPS.findIndex(s => s.id === 'team')
  await page.getByRole('combobox', { name: 'Go to step' }).selectOption(String(team))
  await page.getByText(`Step ${team + 1} of ${GUIDED_STEPS.length}`).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="Agent graph outline"] button[data-graph-node]')].some(b => b.textContent?.startsWith('api-dev,')))
  assert.equal(await hideToggle.getAttribute('aria-pressed'), 'true')
  assert.equal(await stored(), 'true')
  await dialog.getByRole('button', { name: 'Exit tour' }).click()
  await dialog.waitFor({ state: 'detached' })
  // Back to the user's preference: idle and finished agents are hidden again (api-dev is idle, then done)
  await page.waitForFunction(() => ![...document.querySelectorAll('section[aria-label="Agent graph outline"] button[data-graph-node]')].some(b => b.textContent?.startsWith('api-dev,')))
  assert.equal(await stored(), 'true')
})

test('Exit tour closes the card, keeps the app and has no accessibility violation', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  await page.getByRole('dialog').waitFor()
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  assert.deepEqual(results.violations.map(v => v.id), [])
  await page.getByRole('button', { name: 'Exit tour' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.ok(await page.getByRole('button', { name: 'Guided tour' }).isVisible())
})
