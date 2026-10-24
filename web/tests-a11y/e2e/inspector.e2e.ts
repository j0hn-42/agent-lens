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
import { chromium, type Browser, type Frame } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { postWhenListening } from './bridge-ready'
import { closeMore, topbarButton } from './topbar-fold'

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
  const host = await context.newPage()
  // The bridge only accepts messages from window.parent (#202): like VS Code, a host page embeds the app in an
  // iframe that fills the viewport and posts to it. Same origin as the app, served by a route.
  await host.route(`${server.url}/__host`, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>host</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe id="app" src="${server.url}"></iframe>`,
  }))
  await host.goto(`${server.url}/__host`)
  const page = (await (await host.locator('#app').elementHandle())!.contentFrame())!
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  const post = (data: unknown) => host.evaluate((d) => (document.getElementById('app') as HTMLIFrameElement).contentWindow!.postMessage(d, '*'), data)
  // The Sessions button is in the server HTML, so seeing it proves nothing about the bridge: init is repeated until the
  // page answers, then the config and the list are posted (bridge-ready.ts, the race fixed in #603, #613)
  await postWhenListening(host, [
    { type: 'config', showMockData: false },
    { type: 'session-list', sessions: [info('sa', 'payments-api'), info('sb', 'web-app', { lastActivityTime: Date.now() - 5000 })] },
  ])
  // The session list is applied (the Sessions button names the shown session) before agents are posted into it
  await page.getByRole('button', { name: /^Sessions: payments-api/ }).waitFor()
  for (const e of [spawn('sa', { name: 'main-a', isMain: true }), spawn('sa', { name: 'worker-a', parent: 'main-a' }), spawn('sb', { name: 'main-b', isMain: true })]) {
    await post(e)
  }
  // The top bar counts what React knows: wait until both agents of the shown session are in it
  await page.getByText(/2 agents/).first().waitFor()
  // Idle agents are hidden by default. The filter is behind More at every width (one-line bar)
  await (await topbarButton(page, /^Hide inactive/)).evaluate((el: HTMLElement) => el.click())
  await closeMore(page)
  return { page, close: () => context.close() }
}

const selectWorker = (page: Frame) =>
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

  test('#386: at 320 px the git strip of the card reflows (long branch, commit, PR) without horizontal scroll', async () => {
    const { page, close } = await openWithFakeRelay(320, 700)
    try {
      const host = page.parentFrame()!
      const post = (data: unknown) => host.evaluate((d) => (document.getElementById('app') as HTMLIFrameElement).contentWindow!.postMessage(d, '*'), data)
      const branch = 'feat/386-a-very-long-branch-name-that-does-not-fit-in-a-narrow-card'
      const bash = (time: number, id: string, command: string, result: string) => [
        { type: 'agent-event', event: { time, type: 'tool_call_start', sessionId: 'sa', payload: { agent: 'worker-a', tool: 'Bash', args: command, inputData: { command }, toolUseId: id } } },
        { type: 'agent-event', event: { time: time + 1, type: 'tool_call_end', sessionId: 'sa', payload: { agent: 'worker-a', tool: 'Bash', result, toolUseId: id } } },
      ]
      for (const e of [
        ...bash(10, 'g1', `git checkout -b ${branch}`, `Switched to a new branch '${branch}'`),
        ...bash(20, 'g2', 'git commit -m "feat: a commit message long enough to wrap (#386)"', `[${branch} abc1234] feat: a commit message long enough to wrap (#386)`),
        ...bash(30, 'g3', 'gh pr create --draft', 'https://github.com/o/r/pull/12'),
      ]) await post(e)
      await selectWorker(page)
      const strip = page.locator('[data-testid="git-strip"]')
      await strip.waitFor()
      await waitForStableLayout(page)
      assert.match((await strip.textContent()) ?? '', /PR #12 \(o\/r\) created/)
      const box = await strip.boundingBox()
      assert.ok(box && box.x >= -0.5 && box.x + box.width <= 320.5, `the strip is inside the viewport (${JSON.stringify(box)})`)
      const overflow = await strip.evaluate((el: HTMLElement) => el.scrollWidth - el.clientWidth)
      assert.ok(overflow <= 1, `no horizontal overflow in the strip (${overflow} px)`)
    } finally { await close() }
  })
})
