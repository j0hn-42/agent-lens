// #453 (I3, I5): the truncation banner as AgentVisualizer (index.tsx) wires it, mounted with the REAL bridge fed by
// window messages and a normalization_stats event: where it sits (the column under the top bar, after the top bar in
// the Tab order), how the docks see it (an obstacle in dock mode, a measured band over a sheet), that full screen
// leaves it out, what the live region says around full screen, and where the focus goes when it is dismissed.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { PANEL_BUTTON_IDS } from '@/components/agent-visualizer/top-bar'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import { dockStore, intersects, BANNER_MIN_TOP, type Rect } from '@/lib/panel-layout'
import { pressInMore } from './topbar-more'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

const win = window as unknown as { innerWidth: number; innerHeight: number }
const realGetContext = window.HTMLCanvasElement.prototype.getContext
const realRect = window.HTMLElement.prototype.getBoundingClientRect
/** Rectangle jsdom reports for the banner (it has no layout engine) */
let bannerRect: Rect

beforeEach(() => {
  bannerRect = { x: 300, y: 112, w: 420, h: 46 }
  win.innerWidth = 1600
  win.innerHeight = 900
  document.documentElement.style.setProperty('--topbar-h', '68px')
  const ctx: any = new Proxy({ canvas: { width: 800, height: 600 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.hasAttribute('data-truncation-banner')) return realRect.call(this)
    const r = bannerRect
    return { left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h, x: r.x, y: r.y, toJSON() { return this } } as DOMRect
  }
})
afterEach(() => {
  act(() => { for (const id of ['detail', 'system', 'link', 'files', 'conversation', 'timeline'] as const) dockStore.setOpen(id, false) })
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore()
  window.HTMLCanvasElement.prototype.getContext = realGetContext
  window.HTMLElement.prototype.getBoundingClientRect = realRect
  win.innerWidth = 1280
  win.innerHeight = 800
  act(() => dockStore.measure())
})

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const ev = (sessionId: string, type: string, payload: Record<string, unknown>, time = 1) =>
  ({ type: 'agent-event', event: { time, type, sessionId, payload } })
const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const STATS = { ignoredEvents: 3, malformed: 1, droppedByCap: 2, clampedFields: 0, duplicateEvents: 0 }

/** The app with one session whose normalizer discarded events: a real "Graph truncated" banner. */
async function mountWithBanner() {
  const r = render(<AgentVisualizer />)
  const now = Date.now()
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [{ id: 's1', label: 'e2e', status: 'active', startTime: now - 1000, lastActivityTime: now }] })
  })
  await wait(100)
  await act(async () => {
    post(ev('s1', 'agent_spawn', { name: 'main', isMain: true }, 0))
    post(ev('s1', 'normalization_stats', STATS, 1))
  })
  await wait(400)
  return r
}
const banner = (r: ReturnType<typeof render>) => r.container.querySelector<HTMLElement>('[data-truncation-banner]')

test('the banner is a real one, in the column under the top bar, after the top bar and before the main region', async () => {
  const r = await mountWithBanner()
  const b = banner(r)
  assert.ok(b, 'the normalization_stats event raises the banner')
  assert.match(b!.textContent ?? '', /Graph truncated: 4 events ignored, 2 nodes dropped/)
  const stack = b!.closest('[data-topbar-stack]')
  assert.ok(stack, 'the banner is in the stack')
  assert.ok(stack!.querySelector('[role="status"][data-testid="hidden-panels-notice"]'), 'the hidden-panels notice is in the same column')
  const header = r.container.querySelector('header, [role="banner"]')!
  const main = r.container.querySelector('main')!
  assert.ok(header.compareDocumentPosition(stack!) & Node.DOCUMENT_POSITION_FOLLOWING, 'after the top bar in the Tab order')
  assert.ok(stack!.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING, 'before the main region')
})

test('dock mode: the measured banner is an obstacle the agent card is placed around', async () => {
  const r = await mountWithBanner()
  assert.ok(banner(r))
  // The card would take the top of the left column: put the banner there
  bannerRect = { x: 12, y: 68, w: 420, h: 46 }
  act(() => { dockStore.measure(); dockStore.setOpen('detail', true) })
  const { env, layout } = dockStore.getSnapshot()
  assert.equal(layout.mode, 'dock')
  assert.ok(env.obstacles.some(o => o.x === 12 && o.y === 68 && o.w === 420 && o.h === 46), `the banner is read as an obstacle ${JSON.stringify(env.obstacles)}`)
  assert.ok(!intersects(layout.rects.detail!, bannerRect), 'the card is not placed over the banner')
})

test('sheet mode: the banner height is measured and the sheet starts under it, a lone sheet included', async () => {
  win.innerWidth = 390
  win.innerHeight = 844
  bannerRect = { x: 8, y: 68 + BANNER_MIN_TOP, w: 374, h: 58 }
  const r = await mountWithBanner()
  assert.ok(banner(r))
  act(() => { dockStore.measure(); dockStore.setOpen('timeline', true) })
  const { env, layout } = dockStore.getSnapshot()
  assert.equal(layout.mode, 'sheet')
  assert.equal(env.bannerH, 58)
  // The top bar publishes its own height (--topbar-h); the banner slot is measured from it
  assert.ok(layout.rects.timeline!.y >= env.topbarH + BANNER_MIN_TOP + 58, `the sheet starts under the banner (${layout.rects.timeline!.y}, top bar ${env.topbarH})`)
})

test('full screen leaves the banner out; the live region is quiet there and speaks again when the banner comes back (I3)', async () => {
  const r = await mountWithBanner()
  const live = () => Array.from(r.container.querySelectorAll('.sr-only[role="status"][aria-live="polite"]')).map(el => el.textContent ?? '')
  const said = () => live().some(t => t === 'Graph incomplete or truncated: see the notice under the top bar.')
  assert.ok(banner(r))
  assert.ok(said(), 'announced when it appears')
  await pressInMore(() => r.getByRole('button', { name: 'Enter full screen' }))
  await wait(100)
  assert.equal(banner(r) === null, true, 'no banner in full screen')
  assert.equal(said(), false, 'no sentence pointing at a notice that is not drawn')
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Exit full screen' })) })
  await wait(100)
  assert.ok(banner(r), 'back with the chrome')
  assert.ok(said(), 'the notice is drawn again, and said again')
})

test('dismissing the banner puts the focus on the Sessions button of the top bar', async () => {
  const r = await mountWithBanner()
  const dismiss = r.getByRole('button', { name: 'Dismiss truncation warning' })
  dismiss.focus()
  await act(async () => { fireEvent.click(dismiss) })
  await wait(50)
  // Booleans and ids only: a failed comparison of DOM nodes makes the runner print the whole tree
  assert.equal(banner(r) === null, true)
  const sessions = document.getElementById(PANEL_BUTTON_IDS.sessions)
  assert.ok(sessions, 'the Sessions button carries the id the shell passes as returnFocusId')
  assert.equal(document.activeElement?.id || document.activeElement?.tagName, PANEL_BUTTON_IDS.sessions)
})
