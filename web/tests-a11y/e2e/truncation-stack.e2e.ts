// Real-browser check of the column under the top bar (#453): the truncation banner and the "N panels hidden" notice
// are stacked, and a sheet starts under both, at 320, 390, 600 and 899 px. The demo never shows a banner, so the test
// mounts a real one through the real bridge: the app is embedded in a frame (as in a VS Code webview) and the parent
// posts the messages the extension would send, a normalization_stats event included. No production code is changed.
//
//   pnpm --dir web run test:e2e
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Frame, type Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { topbarButton } from './topbar-fold'

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

interface Box { x: number; y: number; w: number; h: number }
const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5

/** The app in a frame, fed by its parent like a VS Code webview, with a session whose normalizer dropped events. */
async function mountWithBanner(page: Page, w: number, h: number): Promise<Frame> {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<!doctype html><html lang="en"><head><title>frame</title></head><body style="margin:0">
    <iframe id="app" title="Agent Lens" src="${server.url}" style="border:0;width:100vw;height:100vh;display:block"></iframe></body></html>`)
  const frame = (await (await page.$('#app'))!.contentFrame())!
  await frame.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor({ timeout: 120_000 })
  const now = Date.now()
  await page.evaluate((msgs) => {
    const target = (document.getElementById('app') as HTMLIFrameElement).contentWindow!
    for (const m of msgs) target.postMessage(m, '*')
  }, [
    { type: '__vscode-bridge-init' },
    { type: 'session-list', sessions: [{ id: 's1', label: 'e2e', status: 'active', startTime: now, lastActivityTime: now }] },
    { type: 'agent-event', event: { time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true }, sessionId: 's1' } },
    // A running tool keeps the agent drawn ("Hide inactive agents" is on by default)
    { type: 'agent-event', event: { time: 0.5, type: 'tool_call_start', payload: { agent: 'main', tool: 'Read', args: 'a.ts' }, sessionId: 's1' } },
    { type: 'agent-event', event: { time: 1, type: 'normalization_stats', payload: { ignoredEvents: 3, malformed: 1, droppedByCap: 2, clampedFields: 0, duplicateEvents: 0 }, sessionId: 's1' } },
  ])
  await frame.locator('[data-truncation-banner]').waitFor()
  await waitForStableLayout(frame)
  return frame
}

// Runs in the frame. A string (not a function) so the TS transpiler's helpers are not injected into it.
const MEASURE = `(() => {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null }
  const sheets = [...document.querySelectorAll('[data-dock-panel]')].filter(el => getComputedStyle(el).display !== 'none' && !el.closest('[aria-hidden="true"]') && !el.closest('[inert]')).map(box).filter(Boolean)
  return {
    topbar: box(document.querySelector('header, [role="banner"]')),
    notice: box(document.querySelector('[data-hidden-panels-notice]')),
    banner: box(document.querySelector('[data-truncation-banner]')),
    sheets,
  }
})()`
type Measure = { topbar: Box; notice: Box | null; banner: Box | null; sheets: Box[] }

/** The element drawn at the centre of `el` is `el` or inside it: nothing covers it. */
const IS_ON_TOP = `(el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && (top === el || el.contains(top)) }`

async function togglePanel(frame: Frame, name: RegExp) {
  // Under 768 px the panel buttons are behind More, which folds again after each one (#476)
  await (await topbarButton(frame, name)).first().evaluate((el: HTMLElement) => el.click())
}

for (const w of [320, 390, 600, 899]) {
  test(`${w}px: banner under the notice, sheet under both, and the banner's buttons are not covered (#453)`, async () => {
    const page = await browser.newPage()
    try {
      const frame = await mountWithBanner(page, w, 844)
      // Three panels: the newest is the sheet, two are hidden and named by the notice
      await togglePanel(frame, /^Timeline/)
      await togglePanel(frame, /^System/)
      await togglePanel(frame, /^Files/)
      await frame.locator('[data-hidden-panels-notice]').waitFor()
      await waitForStableLayout(frame)
      const m = await frame.evaluate(MEASURE) as Measure
      assert.ok(m.notice && m.banner, `${w}px: notice and banner are drawn ${JSON.stringify(m)}`)
      assert.equal(m.sheets.length, 1, `${w}px: one sheet`)
      assert.ok(m.notice.y >= m.topbar.y + m.topbar.h - 0.5, `${w}px: the notice is under the top bar`)
      assert.ok(!overlap(m.notice, m.banner), `${w}px: the banner does not cover the notice ${JSON.stringify(m)}`)
      assert.ok(m.banner.y >= m.notice.y + m.notice.h, `${w}px: the banner is under the notice`)
      assert.ok(!overlap(m.sheets[0], m.banner) && !overlap(m.sheets[0], m.notice), `${w}px: the sheet starts under both ${JSON.stringify(m)}`)
      for (const name of ['Details', 'Dismiss truncation warning']) {
        const b = frame.getByRole('button', { name, exact: true })
        // What is drawn at the centre of the button: the button itself, or the element that covers it
        const cover = await b.evaluate((el: Element) => {
          const r = el.getBoundingClientRect()
          const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return t === el || (t !== null && el.contains(t)) ? '' : (t ? t.outerHTML.slice(0, 160) : 'nothing')
        })
        assert.equal(cover, '', `${w}px: ${name} is covered`)
      }

      // One panel left: no notice, but the sheet still starts under the banner
      await togglePanel(frame, /^Files/)
      await togglePanel(frame, /^System/)
      await waitForStableLayout(frame)
      const one = await frame.evaluate(MEASURE) as Measure
      assert.equal(one.notice, null, `${w}px: nothing hidden, no notice`)
      assert.equal(one.sheets.length, 1)
      assert.ok(one.banner && !overlap(one.sheets[0], one.banner), `${w}px: a lone sheet does not slide under the banner ${JSON.stringify(one)}`)
    } finally {
      await page.close()
    }
  })
}

test('390px, agent card open: Tab goes from the top bar to the banner, whose buttons are visible when they take the focus (#453)', async () => {
  const page = await browser.newPage()
  try {
    const frame = await mountWithBanner(page, 390, 844)
    await togglePanel(frame, /^Timeline/)
    // The agent card (z 100, above the banner) is the sheet: it used to cover the banner and its buttons
    await frame.getByRole('button', { name: /^main\b/ }).first().evaluate((el: HTMLElement) => el.click())
    await frame.locator('[data-dock-panel="detail"]').waitFor()
    await waitForStableLayout(frame)
    const m = await frame.evaluate(MEASURE) as Measure
    assert.ok(m.banner && m.sheets.length === 1 && !overlap(m.sheets[0], m.banner), `the card sheet starts under the banner ${JSON.stringify(m)}`)
    // The last button of the top bar (More once it is folded under 768 px, #476): the banner comes next in the Tab order
    await frame.locator('header button').last().focus()
    const seen: string[] = []
    for (let i = 0; i < 12 && !seen.includes('Dismiss truncation warning'); i++) {
      await page.keyboard.press('Tab')
      const info = await frame.evaluate(`(() => { const el = document.activeElement; if (!el || el === document.body) return null; const f = ${IS_ON_TOP}; return { name: el.getAttribute('aria-label') || el.textContent.trim(), onTop: f(el), inBanner: !!el.closest('[data-truncation-banner]') } })()`) as { name: string; onTop: boolean; inBanner: boolean } | null
      if (!info) continue
      seen.push(info.name)
      if (info.inBanner) assert.ok(info.onTop, `${info.name} takes the focus while covered`)
    }
    assert.ok(seen.includes('Details') && seen.includes('Dismiss truncation warning'), `the banner is reached with Tab (${seen.join(' > ')})`)
  } finally {
    await page.close()
  }
})

/** What is drawn at the centre of each button: '' when it is the button itself, else the element that covers it. */
async function coveredButtons(frame: Frame, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of names) {
    out[name] = await frame.getByRole('button', { name, exact: true }).evaluate((el: Element) => {
      const r = el.getBoundingClientRect()
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return t === el || (t !== null && el.contains(t)) ? '' : (t ? t.outerHTML.slice(0, 160) : 'nothing')
    })
  }
  return out
}

test('320 x 568 phone: the agent card, then Files with Details open, never cover the banner (#453 review)', async () => {
  const page = await browser.newPage()
  try {
    const frame = await mountWithBanner(page, 320, 568)
    await togglePanel(frame, /^Timeline/)
    await frame.getByRole('button', { name: /^main\b/ }).first().evaluate((el: HTMLElement) => el.click())
    await frame.locator('[data-dock-panel="detail"]').waitFor()
    await waitForStableLayout(frame)
    const card = await frame.evaluate(MEASURE) as Measure
    assert.ok(card.banner && card.sheets.length === 1 && !overlap(card.sheets[0], card.banner), `the card sheet starts under the banner ${JSON.stringify(card)}`)
    assert.ok(!card.notice || !overlap(card.sheets[0], card.notice), `the card sheet starts under the notice ${JSON.stringify(card)}`)
    assert.deepEqual(await coveredButtons(frame, ['Details', 'Dismiss truncation warning']), { Details: '', 'Dismiss truncation warning': '' })

    await togglePanel(frame, /^Files/)
    await frame.locator('[data-dock-panel="files"]').waitFor()
    await waitForStableLayout(frame)
    const files = await frame.evaluate(MEASURE) as Measure
    assert.ok(files.banner && files.notice && files.sheets.length === 1, `notice, banner and one sheet ${JSON.stringify(files)}`)
    assert.ok(!overlap(files.sheets[0], files.banner) && !overlap(files.sheets[0], files.notice), `the Files sheet starts under both ${JSON.stringify(files)}`)
    assert.deepEqual(await coveredButtons(frame, ['Details', 'Dismiss truncation warning']), { Details: '', 'Dismiss truncation warning': '' })

    // Details open: the banner is now taller than any band this area can keep. The sheet keeps the notice band, and
    // the banner (z 55, above the Files sheet at z 40) stays on top with its buttons reachable.
    await frame.getByRole('button', { name: 'Details', exact: true }).evaluate((el: HTMLElement) => el.click())
    await waitForStableLayout(frame)
    const open = await frame.evaluate(MEASURE) as Measure
    assert.ok(open.banner && open.notice && open.sheets.length === 1, `notice, banner and one sheet ${JSON.stringify(open)}`)
    assert.ok(!overlap(open.sheets[0], open.notice), `the Files sheet starts under the notice ${JSON.stringify(open)}`)
    assert.deepEqual(await coveredButtons(frame, ['Details', 'Dismiss truncation warning']), { Details: '', 'Dismiss truncation warning': '' })
  } finally {
    await page.close()
  }
})

// #476: under 768 px an open panel is a drawer that keeps Tab in its cycle; the truncation notice drawn above it is
// part of that cycle (the drawer is not aria-modal), so its buttons stay reachable from the keyboard
test('390px, Timeline drawer open: Tab cycles through the drawer and the notice, never the rest of the page (#476)', async () => {
  const page = await browser.newPage()
  try {
    const frame = await mountWithBanner(page, 390, 844)
    await togglePanel(frame, /^Timeline/)
    const drawer = frame.locator('[data-mobile-drawer]')
    await drawer.waitFor()
    assert.equal(await drawer.getAttribute('aria-modal'), null)
    await frame.waitForFunction(`!!document.activeElement && !!document.activeElement.closest('[data-mobile-drawer]')`)
    const seen = new Set<string>()
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab')
      const where = await frame.evaluate(`(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; if (a.closest('[data-mobile-drawer]')) return 'drawer'; if (a.closest('[data-truncation-banner]')) return 'banner:' + (a.getAttribute('aria-label') || a.textContent.trim()); return 'outside:' + (a.getAttribute('aria-label') || a.textContent.trim()) })()`) as string
      assert.ok(where === 'drawer' || where.startsWith('banner:'), `Tab ${i + 1} went ${where}`)
      seen.add(where.split(':')[0])
    }
    assert.ok(seen.has('banner') && seen.has('drawer'), `both are reached (${[...seen].join(', ')})`)
  } finally {
    await page.close()
  }
})
