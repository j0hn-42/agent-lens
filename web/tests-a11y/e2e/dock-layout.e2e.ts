// Real-browser geometry check for the dock layout (issue #32), now part of `pnpm --dir web run test:e2e`: the
// demo app is started by demo-server.ts (or E2E_BASE_URL points at a running one). At four viewport sizes, with the
// agent card, the timeline and either the Conversation panel or the collapsed message pill showing, it measures
// getBoundingClientRect() and asserts that no two panels intersect and that none covers the top bar or the control bar.
// (Updated for #115: the old version clicked an "Expand messages" button that no longer exists, so it was never
// run in CI; Files cannot sit next to the card any more because selecting an agent opens Conversation, which
// shares the right dock with Files.)
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
    ['feed', '[role="region"][aria-label="Messages"]'], ['pill', '[data-companion-panel]'],
    ['transcript', '[aria-label="Session transcript"]'],
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

async function open(page: Page, w: number, h: number, withConversation: boolean) {
  await page.setViewportSize({ width: w, height: h })
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
  await waitForStableLayout(page)
  await page.getByRole('button', { name: 'Timeline', exact: true }).click({ timeout: 5000 })
  // Select the agent LAST, and without moving focus: the card closes when focus moves to another control. The
  // graph outline button is visually hidden, so activate it through the DOM. Selecting opens Conversation on a wide viewport.
  await page.getByRole('button', { name: /^Refactor the payment/ }).first().evaluate((el: HTMLElement) => el.click())
  await page.locator('[data-dock-panel="detail"]').waitFor()
  await waitForStableLayout(page)
  if (!withConversation && w >= 900) {
    // Close Conversation the same way: the message pill takes its place and the card stays
    await page.getByRole('button', { name: /^Conversation/ }).first().evaluate((el: HTMLElement) => el.click())
    await page.locator('[data-companion-panel]').first().waitFor()
    await waitForStableLayout(page)
  }
}

for (const withConversation of [false, true]) {
  for (const [w, h] of VIEWPORTS) {
    test(`dock: ${w}x${h} (${withConversation ? 'Conversation' : 'message pill'} showing): no panel overlaps another, none covers the top bar or the control bar`, async () => {
      const page = await browser.newPage()
      try {
        await open(page, w, h, withConversation)
        const { panels, foreign, topbar, controlBar } = await collect(page)
        const label = `${w}x${h}`
        // Not vacuous: the card, the timeline and the right-dock panel are really there (one sheet when narrow)
        const names = panels.map(p => p.name)
        if (w >= 900) {
          for (const need of ['detail', 'timeline', ...(withConversation ? ['conversation'] : [])]) {
            assert.ok(names.includes(need), `${label}: ${need} is open (found ${names.join(', ') || 'none'})`)
          }
          if (!withConversation) assert.ok(foreign.some(f => f.name === 'pill'), `${label}: the collapsed message pill is measured`)
        } else {
          assert.ok(names.length >= 1, `${label}: a sheet is open`)
        }
        const sheet = panels.some(p => p.sheet)
        const shown = [...panels, ...(sheet ? [] : foreign)]
        for (let i = 0; i < shown.length; i++) {
          for (let j = i + 1; j < shown.length; j++) {
            // Foreign panels (message pill, transcript) are placed by their own owners: only pairs with a docked panel are ours
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
