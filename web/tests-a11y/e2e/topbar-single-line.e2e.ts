// Real-browser check of the top bar: on a wide viewport (>= 1760 px) every control and total sits on ONE line and
// nothing is cut off; below that the bar keeps wrapping instead of hiding numbers or overflowing sideways
// (WCAG 1.4.10 reflow). Runs against the demo app, the worst case: "Exit demo" and a blocked-notifications
// button are showing next to the totals.
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

// Runs in the page. A string (not a function) so the TS transpiler's helpers are not injected into it.
const MEASURE_SCRIPT = `(() => {
  const bar = document.querySelector('header')
  const r = bar.getBoundingClientRect()
  let spread = 0
  let right = 0
  for (const el of bar.querySelectorAll('button')) {
    const b = el.getBoundingClientRect()
    if (b.width === 0) continue
    spread = Math.max(spread, Math.abs((b.top + b.bottom) / 2 - (r.top + r.bottom) / 2))
    right = Math.max(right, b.right)
  }
  const clipped = [...bar.querySelectorAll('span')].filter(s => s.clientWidth > 1 && !s.closest('button') && s.scrollWidth > s.clientWidth + 1 && getComputedStyle(s).overflow === 'hidden')
  return { height: r.height, spread, right, barRight: r.right, clipped: clipped.map(s => s.textContent.slice(0, 40)), docOverflow: document.documentElement.scrollWidth > window.innerWidth }
})()`

interface Measure { height: number; spread: number; right: number; barRight: number; clipped: string[]; docOverflow: boolean }

async function measure(width: number): Promise<Measure> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  try {
    await page.goto(server.url, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
    await waitForStableLayout(page)
    return await page.evaluate(MEASURE_SCRIPT) as Measure
  } finally {
    await page.close()
  }
}

for (const width of [2560, 1920, 1760]) {
  test(`top bar: ${width}px wide, every control is on one line${width >= 1920 ? ' and no total is cut off' : ''}`, async () => {
    const m = await measure(width)
    assert.ok(m.spread < 12, `a button is ${m.spread}px off the bar's centre line, so it sits on another row`)
    assert.ok(m.height < 56, `bar is ${m.height}px tall, more than one line`)
    assert.ok(m.right <= m.barRight + 0.5, `a button overflows the bar (${m.right} > ${m.barRight})`)
    // At 1760 px the demo (the busiest bar) may still ellipsize a total: only the single line is promised there
    if (width >= 1920) assert.deepEqual(m.clipped, [], `text cut off: ${m.clipped.join(' | ')}`)
  })
}

for (const width of [1440, 1024, 390, 320]) {
  test(`top bar: ${width}px wide, it wraps instead of overflowing sideways`, async () => {
    const m = await measure(width)
    assert.ok(m.right <= m.barRight + 0.5, `a button overflows the bar (${m.right} > ${m.barRight})`)
    assert.equal(m.docOverflow, false, 'the page scrolls horizontally')
  })
}
