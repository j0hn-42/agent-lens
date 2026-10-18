// Real-browser check of the state cell of an agent row in the Sessions panel, in French, at 320 px (#502): a stale
// agent quotes the English line the canvas draws ("last known state: Calling tool") then glosses it in French
// ("dernier état connu : Appel d’outil"). The gloss carries what is proper to the row, so nothing of the cell is cut by
// an ellipsis or by the panel, and the page does not scroll sideways (WCAG 1.4.10). The agents come from a host page
// that posts to the app like VS Code does; the agent is left silent past STALE_AFTER_MS (30 s) to become stale.
//
//   pnpm --dir web run test:e2e
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser } from 'playwright'
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

const STALE_WAIT_MS = 33_000

// Runs in the frame. A string (not a function) so the TS transpiler's helpers are not injected into it.
const MEASURE = `(() => {
  const q = document.querySelector('[data-row-key^="agent:"] [data-drawn-state]')
  const cell = q.parentElement
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
  // Every ancestor that clips its content must hold the whole cell
  const clipped = []
  const c = box(cell)
  for (let el = cell.parentElement; el; el = el.parentElement) {
    const s = getComputedStyle(el)
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue
    const b = box(el)
    if (c.left < b.left - 0.5 || c.right > b.right + 0.5) clipped.push((el.tagName + '.' + el.className).slice(0, 80))
  }
  return {
    text: cell.textContent || '',
    quote: q.textContent || '',
    lang: q.getAttribute('lang'),
    cellScroll: cell.scrollWidth, cellClient: cell.clientWidth,
    textOverflow: getComputedStyle(cell).textOverflow,
    whiteSpace: getComputedStyle(cell).whiteSpace,
    cell: c,
    clipped,
    docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,
  }
})()`
interface Measure {
  text: string; quote: string; lang: string | null; cellScroll: number; cellClient: number; textOverflow: string; whiteSpace: string
  cell: { left: number; right: number; top: number; bottom: number }; clipped: string[]; docScroll: number; docClient: number
}

test('fr 320px: a stale agent row shows its quote and its whole French gloss, nothing cut, no sideways scroll (#502)', { timeout: 300_000 }, async () => {
  const width = 320
  const context = await browser.newContext({ viewport: { width, height: 700 } })
  await context.addInitScript(() => { try { window.localStorage.setItem('agent-lens:locale', 'fr') } catch { /* blocked */ } })
  try {
    const host = await context.newPage()
    // The bridge only accepts messages from window.parent (#202): a host page embeds the app in an iframe, like VS Code
    await host.route(`${server.url}/__host`, route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>host</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe id="app" src="${server.url}"></iframe>`,
    }))
    await host.goto(`${server.url}/__host`)
    const page = (await (await host.locator('#app').elementHandle())!.contentFrame())!
    await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor({ timeout: 120_000 })
    const post = (data: unknown) => host.evaluate((d) => (document.getElementById('app') as HTMLIFrameElement).contentWindow!.postMessage(d, '*'), data)
    const now = Date.now()
    await post({ type: '__vscode-bridge-init' })
    await post({ type: 'config', showMockData: false })
    await post({ type: 'session-list', sessions: [{ id: 's1', label: 'reflow', status: 'active', startTime: now - 1000, lastActivityTime: now, workspace: '/w/reflow', runtime: 'claude' }] })
    await page.getByRole('button', { name: /^Sessions: reflow/ }).waitFor()
    await post({ type: 'agent-event', event: { time: 0, type: 'agent_spawn', payload: { name: 'main-agent-with-a-long-name', isMain: true }, sessionId: 's1' } })
    await post({ type: 'agent-event', event: { time: 0.5, type: 'tool_call_start', payload: { agent: 'main-agent-with-a-long-name', tool: 'Read', args: 'a.ts' }, sessionId: 's1' } })

    await page.getByRole('button', { name: /^Sessions:/ }).click()
    const row = page.locator('[data-row-key^="agent:"]').filter({ hasText: 'main-agent-with-a-long-name' }).first()
    await row.waitFor()
    // Silent past the stale threshold: the row quotes the last known state the canvas draws
    const quote = row.locator('[data-drawn-state]')
    await quote.filter({ hasText: /^last known state: / }).waitFor({ timeout: STALE_WAIT_MS + 30_000 })
    await waitForStableLayout(page)

    const m = await page.evaluate(MEASURE) as Measure
    assert.equal(m.quote, 'last known state: Calling tool', 'the quote is the line the canvas draws for a stale agent')
    assert.equal(m.lang, 'en', 'the quote declares its language')
    assert.equal(m.text, 'last known state: Calling tool : dernier état connu : Appel d’outil', 'the quote, then its whole French gloss')
    assert.notEqual(m.whiteSpace, 'nowrap', 'the cell wraps instead of hiding text')
    assert.ok(m.cellScroll <= m.cellClient + 1, `nothing overflows the cell (scroll ${m.cellScroll} > client ${m.cellClient}, text-overflow ${m.textOverflow})`)
    assert.ok(m.cell.left >= -0.5 && m.cell.right <= width + 0.5, `the cell is inside the viewport (${JSON.stringify(m.cell)})`)
    assert.deepEqual(m.clipped, [], 'no ancestor cuts the cell')
    assert.ok(m.docScroll <= m.docClient, `no sideways scroll (${m.docScroll} > ${m.docClient})`)
  } finally {
    await context.close()
  }
})
