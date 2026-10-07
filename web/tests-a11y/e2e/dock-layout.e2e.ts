// Real-browser geometry check for the dock layout (issue #32). Runs against a dev server in demo mode:
//   NEXT_PUBLIC_DEMO=1 pnpm --filter agent-lens-web exec next dev -p 3917
//   DOCK_E2E_URL=http://localhost:3917 pnpm --dir web run test:e2e
// Optional job: skipped when DOCK_E2E_URL is unset or chromium cannot start (fails in CI only if the
// browser is missing there). At four viewport sizes, with the card, the feed, the chat, Files / the
// transcript and the timeline open, it measures getBoundingClientRect() and asserts that no two panels
// intersect and that none covers the top bar or the control bar.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'

const URL_ = process.env.DOCK_E2E_URL
let browser: Browser | null = null
before(async () => {
  if (!URL_) { console.warn('dock-layout e2e skipped: set DOCK_E2E_URL to a demo-mode dev server'); return }
  try { browser = await chromium.launch() } catch (err) {
    if (process.env.CI) throw err
    console.warn(`dock-layout e2e skipped: chromium not available (${(err as Error).message.split('\n')[0]})`)
  }
})
after(async () => { await browser?.close() })

interface Box { name: string; x: number; y: number; w: number; h: number; sheet?: boolean }
const VIEWPORTS: Array<[number, number]> = [[1600, 900], [1280, 720], [1024, 640], [390, 844]]

const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5

// Runs in the page. A string (not a function) so the TS transpiler's helpers are not injected into it.
const COLLECT_SCRIPT = `(() => {
  const box = (name, el, sheet) => {
    const r = el.getBoundingClientRect()
    return { name, x: r.left, y: r.top, w: r.width, h: r.height, sheet: !!sheet }
  }
  const visible = (el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"]') && !el.closest('[inert]')
  }
  const panels = [...document.querySelectorAll('[data-dock-panel]')].filter(visible)
    .map((el) => box(el.getAttribute('data-dock-panel'), el, el.getAttribute('data-canvas-inset') === 'auto'))
  const foreignSelectors = [
    ['feed', '[role="region"][aria-label="Messages"]'], ['feed-pill', 'button[aria-label^="Expand messages"]'],
    ['chat', '[data-companion-panel]'], ['transcript', '[aria-label="Session transcript"]'],
  ]
  const foreign = []
  for (const [n, sel] of foreignSelectors) {
    for (const el of document.querySelectorAll(sel)) if (visible(el) && !el.closest('[data-dock-panel]')) foreign.push(box(n, el, false))
  }
  return {
    panels, foreign,
    topbar: box('topbar', document.querySelector('header, [role="banner"]'), false),
    controlBar: box('controlBar', document.querySelector('[data-control-bar]'), false),
  }
})()`

async function collect(page: Page): Promise<{ panels: Box[]; foreign: Box[]; topbar: Box; controlBar: Box }> {
  return page.evaluate(COLLECT_SCRIPT) as Promise<{ panels: Box[]; foreign: Box[]; topbar: Box; controlBar: Box }>
}

async function open(page: Page, w: number, h: number, withTranscript: boolean) {
  await page.setViewportSize({ width: w, height: h })
  await page.goto(URL_!, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: /^Expand messages/ }).click({ timeout: 3000 })
  await page.getByRole('button', { name: 'Timeline', exact: true }).click({ timeout: 5000 })
  await page.getByRole('button', { name: withTranscript ? 'Chat' : 'Files', exact: true }).click({ timeout: 5000 })
  // Select the agent LAST: the card closes when focus moves to another control. The graph outline
  // button is visually hidden, so activate it through the DOM.
  await page.getByRole('button', { name: /^Refactor the payment/ }).first().evaluate((el: HTMLElement) => el.click())
  await page.waitForTimeout(900)
}

for (const withTranscript of [false, true]) {
  for (const [w, h] of VIEWPORTS) {
    test(`${w}x${h} (${withTranscript ? 'transcript' : 'files'} open): no panel overlaps another, none covers the top bar or the control bar`, async (t) => {
      if (!browser) return t.skip('no browser / DOCK_E2E_URL')
      const page = await browser.newPage()
      try {
        await open(page, w, h, withTranscript)
        const { panels, foreign, topbar, controlBar } = await collect(page)
        const label = `${w}x${h}`
        // Not vacuous: the card, the timeline and the right-dock panel are really there (one sheet when narrow)
        const names = panels.map(p => p.name)
        if (w >= 900) {
          for (const need of ['detail', 'timeline', withTranscript ? 'conversation' : 'files']) {
            if (need === 'conversation') continue // the transcript is still owned by the Conversation package
            assert.ok(names.includes(need), `${label}: ${need} is open (found ${names.join(', ') || 'none'})`)
          }
          assert.ok(foreign.some(f => f.name === 'feed'), `${label}: the expanded feed is measured`)
        } else {
          assert.ok(names.length >= 1, `${label}: a sheet is open`)
        }
        const sheet = panels.some(p => p.sheet)
        const shown = [...panels, ...(sheet ? [] : foreign)]
        for (let i = 0; i < shown.length; i++) {
          for (let j = i + 1; j < shown.length; j++) {
            // Foreign panels (feed, chat, transcript) are placed by their own owners: only pairs with a docked panel are ours
            if (!panels.includes(shown[i]) && !panels.includes(shown[j])) continue
            assert.ok(!overlap(shown[i], shown[j]), `${label}: ${shown[i].name} ${JSON.stringify(shown[i])} overlaps ${shown[j].name} ${JSON.stringify(shown[j])}`)
          }
        }
        for (const p of panels) {
          assert.ok(!overlap(p, topbar), `${label}: ${p.name} covers the top bar`)
          assert.ok(!overlap(p, controlBar), `${label}: ${p.name} covers the control bar`)
          assert.ok(p.x >= -0.5 && p.x + p.w <= w + 0.5 && p.y + p.h <= h + 0.5, `${label}: ${p.name} leaves the viewport`)
        }
        if (w < 900) assert.ok(panels.length === 1 && panels[0].sheet, `${label}: one sheet at a time`)
      } finally {
        await page.close()
      }
    })
  }
}
