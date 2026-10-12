// Browser checks of the standalone session replay (#237): the exported file opens with no network request and
// no CSP violation (its own script and style run under the hash-pinned policy), the scrubber works with the
// keyboard alone, and axe finds nothing. No server is needed: the page is the generated file itself.
//
//   pnpm --dir web run test:e2e
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { buildSessionExport, renderReplayHtml } from '@/lib/session-export'
import type { SimulationEvent } from '@/lib/agent-types'

let browser: Browser
let dir: string
let fileUrl: string

const events: SimulationEvent[] = [
  { time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true } },
  { time: 1, type: 'message', payload: { agent: 'main', content: '<img src="https://example.com/x.png" onerror="window.__pwned=1">' } },
  { time: 2, type: 'tool_call_start', payload: { agent: 'main', tool: 'WebFetch', args: '<script src="https://example.com/x.js"></script>' } },
  { time: 3, type: 'agent_complete', payload: { name: 'main' } },
]

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-lens-replay-'))
  const file = join(dir, 'replay.html')
  writeFileSync(file, renderReplayHtml(buildSessionExport({ sessionId: 's', label: 'e2e session', events, droppedBefore: 0 })))
  fileUrl = pathToFileURL(file).href
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test('the replay file loads offline: one request (itself), no CSP violation, no injected markup run', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const requests: string[] = []
  const problems: string[] = []
  page.on('request', r => requests.push(r.url()))
  page.on('console', m => { if (m.type() === 'error' || /Content Security Policy|Refused/i.test(m.text())) problems.push(m.text()) })
  page.on('pageerror', e => problems.push(e.message))
  try {
    await page.goto(fileUrl)
    await page.getByRole('slider', { name: 'Position in the session' }).waitFor()
    assert.deepEqual(requests, [fileUrl], 'no request other than the file itself')
    assert.deepEqual(problems, [], 'the inline script and style run under the CSP')
    assert.equal(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), undefined)
    assert.equal(await page.locator('img').count(), 0)
    // The style ran (hash accepted): the body has the theme background, not the browser default white
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    assert.notEqual(bg, 'rgba(0, 0, 0, 0)')
  } finally {
    await context.close()
  }
})

test('the scrubber is driven by the keyboard alone and the position is spoken', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  try {
    await page.goto(fileUrl)
    const slider = page.getByRole('slider', { name: 'Position in the session' })
    await slider.waitFor()
    // Tab reaches the slider before the controls
    for (let i = 0; i < 10 && !(await slider.evaluate(el => el === document.activeElement)); i++) await page.keyboard.press('Tab')
    assert.ok(await slider.evaluate(el => el === document.activeElement), 'the slider is reachable with Tab')
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Event 4 of 4: agent_complete')
    await page.keyboard.press('Home')
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Event 1 of 4: agent_spawn')
    await page.keyboard.press('ArrowRight')
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Event 2 of 4: message')
    await page.keyboard.press('End')
    assert.equal(await slider.getAttribute('aria-valuetext'), 'Event 4 of 4: agent_complete')

    const prev = page.getByRole('button', { name: 'Previous event' })
    await prev.focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('#announce').textContent(), 'Event 3 of 4: tool_call_start')
    await page.keyboard.press('Space')
    assert.equal(await page.locator('#announce').textContent(), 'Event 2 of 4: message')
    // The focused control keeps a visible focus indicator
    const outline = await prev.evaluate(el => getComputedStyle(el).outlineStyle)
    assert.notEqual(outline, 'none')
  } finally {
    await context.close()
  }
})

test('the replay page has no serious axe violation', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  try {
    await page.goto(fileUrl)
    await page.getByRole('slider', { name: 'Position in the session' }).waitFor()
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      assert.deepEqual(results.violations.map(v => `${scheme} ${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`), [])
    }
  } finally {
    await context.close()
  }
})
