// Real-browser check of #567: the truncation notice closed with the keyboard stays closed after a reload in the same
// tab (sessionStorage), the indicator stays in the Sessions panel header, and its button reopens the notice with Enter
// and with Space, Details expanded and focused. The app is embedded in a frame fed by its parent like a VS Code webview
// (as in truncation-stack.e2e.ts). No production code is changed.
//
//   pnpm --dir web run test:e2e
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Frame, type Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { postWhenListening } from './bridge-ready'

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

/** Posts the messages the extension would send: one session whose normalizer dropped events. */
async function feed(page: Page, frame: Frame) {
  await frame.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor({ timeout: 120_000 })
  const now = Date.now()
  // The button above is server HTML: wait for the app to answer the init before posting (#575)
  await postWhenListening(page, [
    { type: 'session-list', sessions: [{ id: 's1', label: 'e2e', status: 'active', startTime: now, lastActivityTime: now }] },
    { type: 'agent-event', event: { time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true }, sessionId: 's1' } },
    { type: 'agent-event', event: { time: 0.5, type: 'tool_call_start', payload: { agent: 'main', tool: 'Read', args: 'a.ts' }, sessionId: 's1' } },
    { type: 'agent-event', event: { time: 1, type: 'normalization_stats', payload: { ignoredEvents: 3, malformed: 1, droppedByCap: 2, clampedFields: 12, duplicateEvents: 0 }, sessionId: 's1' } },
  ])
}

async function mount(page: Page, w: number, h: number): Promise<Frame> {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<!doctype html><html lang="en"><head><title>frame</title></head><body style="margin:0">
    <iframe id="app" title="Agent Lens" src="${server.url}" style="border:0;width:100vw;height:100vh;display:block"></iframe></body></html>`)
  const frame = (await (await page.$('#app'))!.contentFrame())!
  await feed(page, frame)
  return frame
}

const banner = (frame: Frame) => frame.locator('[data-truncation-banner]')
const indicator = (frame: Frame) => frame.locator('#sessions-panel [data-testid="truncation-indicator"]')
const activeName = (frame: Frame) => frame.evaluate(`(() => { const el = document.activeElement; return el ? (el.getAttribute('aria-label') || el.textContent.trim()) : '' })()`) as Promise<string>

async function openSessions(frame: Frame) {
  // A closed panel stays in the DOM (inert, slid away): its state is the one of the toggle
  const toggle = frame.locator('#topbar-toggle-sessions')
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
  await frame.waitForFunction(`document.getElementById('topbar-toggle-sessions').getAttribute('aria-pressed') === 'true'`)
  await indicator(frame).waitFor({ state: 'visible' })
  await waitForStableLayout(frame)
}

test('1280px: closed with Enter, reopened from the Sessions header with Enter then Space, and still closed after a reload (#567)', async () => {
  const page = await browser.newPage()
  try {
    const frame = await mount(page, 1280, 800)
    await banner(frame).waitFor()
    // Close with the keyboard
    await frame.getByRole('button', { name: 'Dismiss truncation warning' }).focus()
    await page.keyboard.press('Enter')
    await banner(frame).waitFor({ state: 'detached' })

    await openSessions(frame)
    assert.match(await indicator(frame).innerText(), /4 events ignored, 2 nodes dropped/)
    for (const key of ['Enter', ' ']) {
      await indicator(frame).getByRole('button', { name: 'Show notice' }).focus()
      // The focus ring is drawn (keyboard focus): an outline or a box-shadow
      const ring = await indicator(frame).getByRole('button', { name: 'Show notice' }).evaluate((el: Element) => {
        const s = getComputedStyle(el)
        return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'
      })
      assert.ok(ring, `visible focus on Show notice before ${JSON.stringify(key)}`)
      await page.keyboard.press(key === ' ' ? 'Space' : key)
      await banner(frame).waitFor()
      const details = frame.getByRole('button', { name: 'Details', exact: true })
      assert.equal(await details.getAttribute('aria-expanded'), 'true', `${JSON.stringify(key)}: Details is open`)
      assert.equal(await activeName(frame), 'Details', `${JSON.stringify(key)}: the focus is on Details`)
      await frame.getByRole('button', { name: 'Dismiss truncation warning' }).focus()
      await page.keyboard.press('Space')
      await banner(frame).waitFor({ state: 'detached' })
      await openSessions(frame)
    }

    // Reload in the same tab: the notice stays closed at the same total, the indicator is still there
    const before = await frame.evaluate(`sessionStorage.getItem('agent-lens:truncation-dismissed')`)
    assert.ok(before, `the dismissal is stored for the tab (${before})`)
    // goto waits for the new document (a bare location.reload() would let feed() talk to the old one)
    await frame.goto(server.url)
    await feed(page, frame)
    await openSessions(frame)
    await waitForStableLayout(frame)
    assert.equal(await banner(frame).count(), 0, 'still closed after the reload')
  } finally {
    await page.close()
  }
})

/** Where the ⚠ of the Sessions button is drawn, and whether the button holds it (#569 review) */
const markBox = (frame: Frame) => frame.locator('#topbar-toggle-sessions').evaluate((btn: Element) => {
  const mark = btn.querySelector('[data-loss-mark] [aria-hidden="true"]')
  if (!mark) return null
  const b = btn.getBoundingClientRect()
  const m = mark.getBoundingClientRect()
  return {
    drawn: m.width > 0 && m.height > 0,
    inside: m.left >= b.left - 0.5 && m.right <= b.right + 0.5 && m.top >= b.top - 0.5 && m.bottom <= b.bottom + 0.5,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }
})

test('1280px: after a dismissal the Sessions button carries ⚠ with its words; leaving full screen never focuses Details (#569 review)', async () => {
  const page = await browser.newPage()
  try {
    const frame = await mount(page, 1280, 800)
    await banner(frame).waitFor()
    assert.equal(await markBox(frame), null, 'no mark while the notice shows')
    await frame.getByRole('button', { name: 'Dismiss truncation warning' }).focus()
    await page.keyboard.press('Enter')
    await banner(frame).waitFor({ state: 'detached' })
    assert.deepEqual(await markBox(frame), { drawn: true, inside: true, overflow: false })
    const name = await frame.locator('#topbar-toggle-sessions').evaluate((el: Element) => el.textContent ?? '')
    assert.match(name, /graph incomplete, losses listed in the Sessions panel/)

    // Reopen from the indicator: the focus goes to Details once
    await openSessions(frame)
    await indicator(frame).getByRole('button', { name: 'Show notice' }).focus()
    await page.keyboard.press('Enter')
    await banner(frame).waitFor()
    assert.equal(await activeName(frame), 'Details')
    assert.equal(await markBox(frame), null, 'the mark goes away while the notice shows')

    // Full screen and back: record every focus move inside the app
    await frame.evaluate(`(() => { window.__moves = []; document.addEventListener('focusin', e => window.__moves.push((e.target.getAttribute('aria-label') || e.target.textContent || '').trim())) })()`)
    await frame.getByRole('button', { name: 'Enter full screen' }).click()
    await banner(frame).waitFor({ state: 'detached' })
    await frame.getByRole('button', { name: 'Exit full screen' }).click()
    await banner(frame).waitFor()
    await waitForStableLayout(frame)
    const moves = await frame.evaluate('window.__moves') as string[]
    assert.equal(moves.includes('Details'), false, `Details never took the focus (${JSON.stringify(moves)})`)
    assert.notEqual(await activeName(frame), 'Details')
  } finally {
    await page.close()
  }
})

test('320px: the indicator wraps inside the Sessions panel and its button is not covered (#567)', async () => {
  const page = await browser.newPage()
  try {
    const frame = await mount(page, 320, 640)
    await banner(frame).waitFor()
    await frame.getByRole('button', { name: 'Dismiss truncation warning' }).evaluate((el: HTMLElement) => el.click())
    await banner(frame).waitFor({ state: 'detached' })
    await waitForStableLayout(frame)
    assert.deepEqual(await markBox(frame), { drawn: true, inside: true, overflow: false }, 'the ⚠ of the Sessions button fits at 320 px (#569 review)')
    await openSessions(frame)
    await waitForStableLayout(frame)
    const m = await indicator(frame).evaluate((el: Element) => {
      const panel = el.closest('#sessions-panel')!.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const btn = el.querySelector('button')!
      const b = btn.getBoundingClientRect()
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      return {
        inside: r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        cover: top === btn || btn.contains(top) ? '' : (top ? top.outerHTML.slice(0, 200) : 'nothing'),
      }
    })
    assert.deepEqual(m, { inside: true, overflow: false, cover: '' })
  } finally {
    await page.close()
  }
})
