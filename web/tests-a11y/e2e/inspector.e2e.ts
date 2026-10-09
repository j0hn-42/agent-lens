// Real-browser checks of the agent inspector (issues #115 and #116), fed like the extension feeds it: by window
// messages (`__vscode-bridge-init`, `session-list`, `agent-event`), on the demo app that demo-server.ts starts.
//
//   pnpm --dir web run test:e2e
//
// - AgentGoneCard: select an agent, then make it leave the view (another session is shown) and check that the
//   real card says so. jsdom reaches it too (visualizer-wiring.test.tsx); this proves it in a browser.
// - Narrow viewport (640 px = 200 % zoom, 320 px = 400 %): the inspector of a selected agent is readable; the
//   selection no longer opens Conversation over it.
//
// Notes on how the page is driven:
// - The #115 test uses real pointer clicks, like a user: it opens Sessions AFTER the selection and picks another
//   session. Moving focus to the Sessions button or panel must not close the card (and drop the selection).
// - The simulation publishes its state to React at most every ~250 ms: the page is driven by waiting for what it
//   renders (agent count, card text, stable layout), never for a fixed delay.
import { test, before, after, describe } from 'node:test'
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

const info = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id, label, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: `/w/${label}`, runtime: 'claude', ...extra,
})
const spawn = (sessionId: string, payload: Record<string, unknown>) =>
  ({ type: 'agent-event', event: { time: 1, type: 'agent_spawn', sessionId, payload } })

/** Two sessions: payments-api (main-a and its worker-a, the one shown) and web-app (main-b). */
async function openWithFakeRelay(width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  await page.goto(server.url)
  await page.getByRole('button', { name: 'Files' }).waitFor()
  const post = (data: unknown) => page.evaluate((d) => window.postMessage(d, '*'), data)
  await post({ type: '__vscode-bridge-init' })
  await post({ type: 'config', showMockData: false })
  await post({ type: 'session-list', sessions: [info('sa', 'payments-api'), info('sb', 'web-app', { lastActivityTime: Date.now() - 5000 })] })
  // The session list is applied (the Sessions button names the shown session) before agents are posted into it
  await page.getByRole('button', { name: /^Sessions: payments-api/ }).waitFor()
  for (const e of [spawn('sa', { name: 'main-a', isMain: true }), spawn('sa', { name: 'worker-a', parent: 'main-a' }), spawn('sb', { name: 'main-b', isMain: true })]) {
    await post(e)
  }
  // The top bar counts what React knows: wait until both agents of the shown session are in it
  await page.getByText(/2 agents/).first().waitFor()
  // Idle agents are hidden by default
  await page.getByRole('button', { name: /Hide inactive agents/ }).evaluate((el: HTMLElement) => el.click())
  return { page, close: () => context.close() }
}

const selectWorker = (page: Page) =>
  page.locator('button[data-graph-node]', { hasText: /^worker-a/ }).first().evaluate((el: HTMLElement) => el.click())

describe('agent inspector in a real browser', () => {
  test('#115: the card says the agent is no longer listed when it leaves the view, naming it', async () => {
    const { page, close } = await openWithFakeRelay(1280, 800)
    try {
      await selectWorker(page)
      const detail = page.locator('[data-dock-panel="detail"]')
      await detail.filter({ hasText: 'worker-a' }).waitFor()
      assert.equal(await page.locator('[data-testid="inspector-gone"]').count(), 0, 'a listed agent has its detail card, not the gone one')

      // Open Sessions and show the other session with real clicks: the agents of payments-api leave the graph and
      // the selection is kept (focus moving to the Sessions button / panel does not close the card)
      await page.getByRole('button', { name: /^Sessions:/ }).click()
      await page.locator('[data-row-main]').first().waitFor()
      await page.locator('[data-row-main]').filter({ hasText: /web-app/ }).last().click()
      const gone = page.locator('[data-testid="inspector-gone"]')
      await gone.waitFor()
      assert.match((await gone.textContent()) ?? '', /worker-a/, 'it names the node it remembered')
      assert.equal(await page.locator('[data-dock-panel="detail"]').getByText(/Context/).count(), 0, 'no stale value of the old agent is shown')
      const box = await page.locator('[data-dock-panel="detail"]').boundingBox()
      assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x + box.width <= 1280, `the gone card is visible in the viewport (${JSON.stringify(box)})`)
    } finally { await close() }
  })

  for (const width of [640, 320]) {
    test(`#116: at ${width} px the inspector of the selected agent is readable and Conversation does not cover it`, async () => {
      const { page, close } = await openWithFakeRelay(width, 700)
      try {
        await selectWorker(page)
        const detail = page.locator('[data-dock-panel="detail"]')
        await detail.filter({ hasText: 'worker-a' }).waitFor()
        await waitForStableLayout(page)
        const box = await detail.boundingBox()
        assert.ok(box && box.width > 0 && box.height > 0, `the card has a size (${JSON.stringify(box)})`)
        assert.ok(box.x >= -0.5 && box.x + box.width <= width + 0.5, `the card is inside the viewport (${JSON.stringify(box)})`)
        assert.notEqual(await detail.evaluate((el: HTMLElement) => getComputedStyle(el).display), 'none', 'the card is not display:none')
        assert.equal(await page.getByRole('region', { name: 'Conversation' }).count(), 0, 'the selection did not open Conversation over the card')
      } finally { await close() }
    })
  }
})
