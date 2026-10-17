// #497: the SUMMARY of the top bar (agents, tokens in context, cost) is one short text line at 1440 and 1024 px, with
// the real worst-case figures of the issue ("30 agents: 0 active - 4 last known state - 26 done" / "at least 5.3M
// estimated tokens in context· at least ~$40.49 estimated"). What is measured is the summary, not the whole bar: the
// bar also holds the Sessions button, the scope, the connection state, the filters and the panel buttons, which still
// wrap onto their own rows (the rest of #497). The demo has few agents and no partial or estimated totals, and the app
// has no way to feed it those figures without new production code, so the drawn summary text is replaced by the text
// the real helpers build from those figures, inside the real bar. The popover is then driven with the mouse and the
// keyboard on the real component.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { formatAgentCounts, formatAgentCountsCompact, topBarContextText, topBarContextCompact } from '../../lib/chrome-utils'

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

const tokens = { value: 5_300_000, status: 'partial', estimated: true } as const
const cost = { value: 40.49, status: 'partial', estimated: true } as const
const LONG = [formatAgentCounts(0, 26, 4), topBarContextText(tokens, cost).tokens + '· ' + topBarContextText(tokens, cost).cost].join(' ')
const COMPACT = [formatAgentCountsCompact(0, 26, 4), topBarContextCompact(tokens, cost).tokens, topBarContextCompact(tokens, cost).cost].join(' · ')

async function open(w: number, h: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h } })
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  await waitForStableLayout(page)
  return page
}

/** Draws `text` as the summary of the bar, the way the component draws its compact line. */
const setSummary = (page: Page, text: string) =>
  page.evaluate(`document.querySelector('[data-testid="topbar-summary-compact"]').textContent = ${JSON.stringify(text)}`)

/** The summary block and the bar: height of the summary, width of its text, height of the bar. */
const measure = (page: Page) => page.evaluate(`(() => {
  const s = document.querySelector('[data-testid="topbar-summary"]').getBoundingClientRect()
  const c = document.querySelector('[data-testid="topbar-summary-compact"]')
  const range = document.createRange(); range.selectNodeContents(c)
  const lineHeight = parseFloat(getComputedStyle(c).lineHeight) || 16
  return { summaryHeight: s.height, textWidth: range.getBoundingClientRect().width, lineHeight, barHeight: document.querySelector('header').getBoundingClientRect().height }
})()`) as Promise<{ summaryHeight: number; textWidth: number; lineHeight: number; barHeight: number }>

const isOpen = (page: Page) => page.getByTestId('topbar-summary').getAttribute('data-open')
const waitClosed = (page: Page) => page.waitForFunction(`document.querySelector('[data-testid="topbar-summary"]').dataset.open === 'false'`, undefined, { timeout: 5000 })

for (const [w, h] of [[1440, 900], [1024, 768]] as Array<[number, number]>) {
  test(`top bar ${w}x${h}: the summary text with the issue's figures is a single line (the other controls of the bar may still wrap)`, async () => {
    const page = await open(w, h)
    try {
      const demo = await measure(page)
      await setSummary(page, LONG)
      await page.evaluate(`document.querySelector('[data-testid="topbar-summary"]').style.whiteSpace = 'normal'`)
      const before = await measure(page)
      await page.evaluate(`document.querySelector('[data-testid="topbar-summary"]').style.whiteSpace = ''`)
      await setSummary(page, COMPACT)
      const after = await measure(page)
      assert.ok(after.summaryHeight < after.lineHeight * 1.6, `summary ${after.summaryHeight} px high (line ${after.lineHeight} px) for "${COMPACT}"`)
      assert.ok(after.barHeight <= before.barHeight, `bar ${after.barHeight} px with the compact summary, ${before.barHeight} px with the former text`)
      assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll')
      console.log(`#497 ${w}px: demo bar ${demo.barHeight} px; former text ${before.summaryHeight} px high, bar ${before.barHeight} px; compact ${after.summaryHeight} px high, bar ${after.barHeight} px`)
    } finally {
      await page.context().close()
    }
  })
}

test('the compact summary is much narrower than the former long text', async () => {
  const page = await open(1440, 900)
  try {
    await setSummary(page, LONG)
    const long = await measure(page)
    await setSummary(page, COMPACT)
    const compact = await measure(page)
    assert.ok(compact.textWidth < long.textWidth * 0.75, `compact ${compact.textWidth} px vs long ${long.textWidth} px`)
  } finally {
    await page.context().close()
  }
})

test('top bar 1440x900: the full text opens on hover and on focus, Escape closes it, the focus stays', async () => {
  const page = await open(1440, 900)
  try {
    const group = page.getByTestId('topbar-summary')
    const full = page.getByTestId('topbar-summary-full')
    assert.ok(!(await full.evaluate((el: Element) => el.getBoundingClientRect().width > 4)), 'closed: the full text is not drawn')
    await group.hover()
    assert.equal(await isOpen(page), 'true')
    assert.ok(await full.evaluate((el: Element) => el.getBoundingClientRect().width > 100), 'hover: the full text is drawn')
    // The pointer can move onto the popover without closing it (1.4.13)
    await full.hover()
    assert.equal(await isOpen(page), 'true')
    await page.mouse.move(5, 500)
    await waitClosed(page)

    await group.focus()
    assert.equal(await isOpen(page), 'true', 'focus opens it')
    await page.keyboard.press('Escape')
    assert.equal(await isOpen(page), 'false', 'Escape closes it')
    assert.ok(await group.evaluate((el: Element) => el === document.activeElement), 'the focus did not move')
  } finally {
    await page.context().close()
  }
})

test('top bar 1440x900: a popover opened by hover closes with Escape while the focus is on another control (1.4.13)', async () => {
  const page = await open(1440, 900)
  try {
    const timeline = page.locator('header').getByRole('button', { name: 'Timeline', exact: true })
    await timeline.focus()
    await page.getByTestId('topbar-summary').hover()
    assert.equal(await isOpen(page), 'true', 'hover opened it')
    await page.keyboard.press('Escape')
    assert.equal(await isOpen(page), 'false', 'Escape closed it')
    assert.ok(await timeline.evaluate((el: Element) => el === document.activeElement), 'the focus stayed on Timeline')
    assert.equal(await timeline.getAttribute('aria-pressed'), 'false', 'Escape did nothing else')
  } finally {
    await page.context().close()
  }
})

for (const [w, h] of [[1440, 900], [1024, 768]] as Array<[number, number]>) {
  test(`top bar ${w}x${h}: the open popover is below the bar and covers none of its controls`, async () => {
    const page = await open(w, h)
    try {
      await setSummary(page, COMPACT)
      await page.getByTestId('topbar-summary').hover()
      assert.equal(await isOpen(page), 'true')
      const r = await page.evaluate(`(() => {
        const bar = document.querySelector('header').getBoundingClientRect()
        const pop = document.querySelector('[data-testid="topbar-summary-full"]').getBoundingClientRect()
        const covered = [...document.querySelectorAll('header button, header [role="combobox"]')].filter(el => {
          const b = el.getBoundingClientRect()
          if (b.width === 0 || b.height === 0) return false
          const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
          return !top || !(top === el || el.contains(top))
        }).map(el => el.getAttribute('aria-label') || el.textContent.trim())
        return { barBottom: bar.bottom, popTop: pop.top, popLeft: pop.left, popRight: pop.right, covered, width: window.innerWidth }
      })()`) as { barBottom: number; popTop: number; popLeft: number; popRight: number; covered: string[]; width: number }
      assert.ok(r.popTop >= r.barBottom, `popover top ${r.popTop} is below the bar (${r.barBottom})`)
      assert.deepEqual(r.covered, [], 'no control of the bar is covered')
      assert.ok(r.popLeft >= 0 && r.popRight <= r.width, `popover [${r.popLeft}, ${r.popRight}] inside the ${r.width} px window`)
    } finally {
      await page.context().close()
    }
  })
}
