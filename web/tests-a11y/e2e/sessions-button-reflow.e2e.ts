// Real-browser check of the Sessions button of the top bar when « non observées » is shown (#595): « Sessions : Toutes
// les sessions » was cut by an ellipsis at 320 px in French. The visible label wraps instead of being cut, the
// accessible name stays whole, and the page does not scroll sideways (WCAG 1.4.10). Measured in fr and en.
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

// Runs in the frame. A string (not a function) so the TS transpiler's helpers are not injected into it.
const MEASURE = `(() => {
  const btn = [...document.querySelectorAll('header button')].find(b => /^Sessions\\s?:/.test(b.textContent || ''))
  if (!btn) return null
  const label = btn.querySelector('[data-sensitive]')
  const r = btn.getBoundingClientRect()
  const l = label.getBoundingClientRect()
  return {
    label: label.textContent || '', buttonText: btn.textContent || '',
    labelScroll: label.scrollWidth, labelClient: label.clientWidth, labelHeight: l.height,
    textOverflow: getComputedStyle(label).textOverflow, overflowX: getComputedStyle(label).overflowX,
    button: { left: r.left, right: r.right, width: r.width, height: r.height },
    docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,
  }
})()`
interface Measure {
  label: string; buttonText: string; labelScroll: number; labelClient: number; labelHeight: number; textOverflow: string; overflowX: string
  button: { left: number; right: number; width: number; height: number }; docScroll: number; docClient: number
}

const CASES = [
  { locale: 'fr', label: 'Toutes les sessions', unobserved: /sessions? non observ[ée]es?/, button: /^Sessions\s?: Toutes les sessions/ },
  { locale: 'en', label: 'All sessions', unobserved: /sessions? not observed/, button: /^Sessions\s?: All sessions/ },
] as const
// A named selection with a long name keeps one line (ellipsis past the button width): the bar does not grow with the data
const LONG = 'Refactor the relay hardening pipeline today'

for (const c0 of CASES) for (const long of [false, true]) {
  const c = long ? { ...c0, label: LONG, button: /^Sessions\s?: Refactor/ } : c0
  for (const width of [320, 768]) {
    test(`${c.locale} ${width}px: the Sessions button ${long ? 'keeps one line for a long session name' : 'shows its whole label next to the unobserved count'} (#595)`, { timeout: 300_000 }, async () => {
      const context = await browser.newContext({ viewport: { width, height: 700 } })
      await context.addInitScript((loc) => { try { window.localStorage.setItem('agent-lens:locale', loc) } catch { /* blocked */ } }, c.locale)
      try {
        const host = await context.newPage()
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
        // Two listed sessions, no event heard from either: both are « not observed », the selection is « all sessions »
        await post({ type: 'session-list', sessions: [
          { id: 's1', label: long ? LONG : 'one', status: 'active', startTime: now - 1000, lastActivityTime: now, workspace: '/w/one', runtime: 'claude' },
          { id: 's2', label: 'two', status: 'active', startTime: now - 1000, lastActivityTime: now, workspace: '/w/two', runtime: 'claude' },
        ] })
        // Select « all sessions » in the panel, then close it: the button now carries the longest selection label
        await page.locator('header').getByRole('button', { name: /^Sessions\s?:/ }).click()
        await page.locator('[data-row-key^="session:"]').filter({ hasText: c.label }).first().click()
        await page.locator('header').getByRole('button', { name: /^Sessions\s?:/ }).click()
        await page.locator('header').getByRole('button', { name: c.button }).waitFor({ timeout: 60_000 })
        await waitForStableLayout(page)
        const m = await page.evaluate(MEASURE) as Measure | null
        assert.ok(m, 'the Sessions button is rendered')
        console.log(`sessions button ${c.locale} ${width}px: ${JSON.stringify(m)}`)
        assert.match(m.buttonText, c.unobserved, 'the unobserved count is shown')
        assert.ok(m.label.includes(c.label), `the label is whole in the DOM: ${m.label}`)
        if (long) {
          // Named selection: one line, never taller than the « all sessions » case, the bar does not grow with the name
          assert.ok(m.button.height <= 46, `the button stays as tall as with « all sessions » (${m.button.height})`)
        } else assert.ok(m.labelScroll <= m.labelClient + 1, `the label is not cut (scroll ${m.labelScroll} > client ${m.labelClient}, text-overflow ${m.textOverflow})`)
        assert.ok(m.labelHeight < 20, `the label is on one line (height ${m.labelHeight})`)
        if (!long) assert.notEqual(m.textOverflow, 'ellipsis', 'no ellipsis hides the label')
        assert.ok(m.button.left >= -0.5 && m.button.right <= width + 0.5, `the button is inside the viewport (${JSON.stringify(m.button)})`)
        assert.ok(m.docScroll <= m.docClient, `no sideways scroll (${m.docScroll} > ${m.docClient})`)
        const name = await page.locator('header').getByRole('button', { name: c.button }).first().getAttribute('aria-label')
        assert.equal(name, null, 'the accessible name is the visible text, whole')
      } finally {
        await context.close()
      }
    })
  }
}
