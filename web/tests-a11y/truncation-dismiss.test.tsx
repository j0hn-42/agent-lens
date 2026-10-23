// #567: the "Graph incomplete / truncated" banner as AgentVisualizer wires it, with the REAL bridge fed by window
// messages. Its dismissal lasts as long as the tab (sessionStorage, per view, with the total dismissed at), it comes
// back when more is lost, a short indicator stays in the Sessions panel header and reopens it, and a storage that
// throws breaks nothing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { PANEL_BUTTON_IDS } from '@/components/agent-visualizer/top-bar'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import { inMore } from './topbar-more'
import { waitFor } from './wait-for'

/** The sessionStorage key the dismissals live under (lib/event-loss) */
const TRUNCATION_DISMISS_STORAGE_KEY = 'agent-lens:truncation-dismissed'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

const realGetContext = window.HTMLCanvasElement.prototype.getContext

beforeEach(() => {
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
  try { window.sessionStorage.clear() } catch { /* restored below */ }
})
afterEach(() => {
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore()
  // The bridge is a singleton: the extension's figure of a test would outlive it
  vscodeBridge!.dispatch({ type: 'event-loss', evicted: {} })
  window.HTMLCanvasElement.prototype.getContext = realGetContext
  try { window.sessionStorage.clear() } catch { /* nothing stored */ }
})

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const ev = (sessionId: string, type: string, payload: Record<string, unknown>, time = 1) =>
  ({ type: 'agent-event', event: { time, type, sessionId, payload } })
const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const STATS = { ignoredEvents: 3, malformed: 1, droppedByCap: 2, clampedFields: 12, duplicateEvents: 0 }

/** The app with sessions whose normalizer discarded events (a real banner); `stats` per session id. */
async function mount(stats: Record<string, typeof STATS> = { s1: STATS }) {
  const r = render(<AgentVisualizer />)
  const now = Date.now()
  const ids = Object.keys(stats).length > 1 ? Object.keys(stats) : ['s1']
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: ids.map(id => ({ id, label: `e2e-${id}`, status: 'active', startTime: now - 1000, lastActivityTime: now })) })
  })
  await wait(100)
  await act(async () => {
    for (const id of ids) {
      post(ev(id, 'agent_spawn', { name: `main-${id}`, isMain: true }, 0))
      post(ev(id, 'normalization_stats', stats[id] ?? STATS, 1))
    }
  })
  // #440: the banner follows the throttled UI commit: wait for it, not for a fixed time
  await waitFor(() => banner(r) !== null)
  return r
}
const banner = (r: ReturnType<typeof render>) => r.container.querySelector<HTMLElement>('[data-truncation-banner]')
const indicator = () => document.querySelector<HTMLElement>('#sessions-panel [data-testid="truncation-indicator"]')
const dismiss = async (r: ReturnType<typeof render>) => {
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Dismiss truncation warning' })) })
  await wait(50)
}
const openSessions = async () => {
  await act(async () => { fireEvent.click(document.getElementById(PANEL_BUTTON_IDS.sessions)!) })
  await wait(50)
}
/** Rows of the Sessions panel: [0] is All, then the sessions */
const selectRow = async (i: number) => {
  await act(async () => { fireEvent.click(document.querySelectorAll<HTMLElement>('#sessions-panel [data-row-main]')[i]) })
  await wait(300)
}

test('a dismissal lasts for the tab: a new page in the same tab (remount) keeps the banner closed at the same total', async () => {
  const first = await mount()
  assert.ok(banner(first), 'shown at first')
  await dismiss(first)
  assert.equal(banner(first) === null, true, 'closed')
  const stored = window.sessionStorage.getItem(TRUNCATION_DISMISS_STORAGE_KEY)
  assert.ok(stored && /6/.test(stored), `the total dismissed at is stored for the tab (${stored})`)
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore()
  const again = await mount()
  assert.equal(banner(again) === null, true, 'still closed after the remount')
})

test('the banner comes back when more is lost in the same view', async () => {
  const r = await mount()
  await dismiss(r)
  assert.equal(banner(r) === null, true)
  await act(async () => { post(ev('s1', 'normalization_stats', { ...STATS, ignoredEvents: 4 }, 2)) })
  await wait(400)
  assert.ok(banner(r), 'one more event ignored: back')
})

test('after dismissal, the indicator stays in the Sessions panel header and reopens the banner with its details, focus on Details', async () => {
  const r = await mount()
  await dismiss(r)
  await openSessions()
  const el = indicator()
  assert.ok(el, 'the indicator is drawn in the Sessions panel')
  assert.ok(el!.closest('#sessions-panel'), 'inside the Sessions panel')
  assert.match(el!.textContent ?? '', /4 events ignored, 2 nodes dropped/)
  const btn = el!.querySelector('button')!
  assert.equal(btn.getAttribute('type'), 'button', 'a native button: Enter and Space activate it')
  btn.focus()
  await act(async () => { fireEvent.click(btn) })
  await wait(100)
  const b = banner(r)
  assert.ok(b, 'reopened')
  const details = r.getByRole('button', { name: 'Details' })
  assert.equal(details.getAttribute('aria-expanded'), 'true', 'with its details open')
  assert.equal(document.activeElement === details, true, 'the focus is on the Details toggle')
  assert.equal(window.sessionStorage.getItem(TRUNCATION_DISMISS_STORAGE_KEY)?.includes('6'), false, 'the stored dismissal of this view is cleared')
})

test('no indicator without a loss: adjustments alone (fields shortened) do not draw it', async () => {
  await mount({ s1: { ignoredEvents: 0, malformed: 0, droppedByCap: 0, clampedFields: 12, duplicateEvents: 3 } })
  await openSessions()
  assert.equal(indicator() === null, true)
})

test('a sessionStorage that throws breaks nothing: the banner shows, closes for the page, and the indicator stays', async () => {
  const g = globalThis as Record<string, unknown>
  const own = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
  const ownGlobal = Object.getOwnPropertyDescriptor(g, 'sessionStorage')
  const thrower = { configurable: true, get() { throw new Error('SecurityError') } }
  Object.defineProperty(window, 'sessionStorage', thrower)
  if ((g as unknown) !== window) Object.defineProperty(g, 'sessionStorage', thrower)
  try {
    const r = await mount()
    assert.ok(banner(r))
    await dismiss(r)
    assert.equal(banner(r) === null, true, 'closed for this page')
    await openSessions()
    assert.ok(indicator(), 'the loss stays visible')
  } finally {
    if (own) Object.defineProperty(window, 'sessionStorage', own); else delete (window as unknown as Record<string, unknown>).sessionStorage
    if ((g as unknown) !== window) { if (ownGlobal) Object.defineProperty(g, 'sessionStorage', ownGlobal); else delete g.sessionStorage }
  }
})

test('All then a session: dismissed in All, a session it counted stays closed at the same total; more lost there brings it back', async () => {
  const r = await mount({ s1: STATS, s2: { ignoredEvents: 0, malformed: 0, droppedByCap: 0, clampedFields: 0, duplicateEvents: 0 } })
  await openSessions()
  await selectRow(0)
  assert.ok(banner(r), 'shown in All')
  await dismiss(r)
  assert.equal(banner(r) === null, true)
  const rows = Array.from(document.querySelectorAll<HTMLElement>('#sessions-panel [data-row-main]')).map(el => el.textContent ?? '')
  const s1 = rows.findIndex(t => t.includes('e2e-s1'))
  const s2 = rows.findIndex(t => t.includes('e2e-s2'))
  assert.ok(s1 > 0 && s2 > 0, `both session rows are listed (${JSON.stringify(rows)})`)
  await selectRow(s1)
  assert.equal(banner(r) === null, true, 's1, which All counted, stays closed at the same total')
  assert.ok(indicator(), 'the indicator still names the loss of s1')
  await selectRow(s2)
  assert.equal(banner(r) === null, true, 's2 lost nothing')
  await act(async () => { post(ev('s1', 'normalization_stats', { ...STATS, droppedByCap: 3 }, 2)) })
  await wait(400)
  await selectRow(s1)
  assert.ok(banner(r), 'one more node dropped in s1: back')
})

// ─── #569 review ─────────────────────────────────────────────────────────────

const sessionsButton = () => document.getElementById(PANEL_BUTTON_IDS.sessions)!
const sessionsMark = () => sessionsButton().querySelector<HTMLElement>('[data-loss-mark]')

test('once dismissed, the loss stays visible outside the Sessions panel: a mark on the Sessions button, named for screen readers', async () => {
  const r = await mount()
  assert.equal(sessionsMark() === null, true, 'no mark while the banner itself shows')
  await dismiss(r)
  const mark = sessionsMark()
  assert.ok(mark, 'the Sessions button of the top bar carries a mark after the dismissal (panel closed)')
  assert.match(mark!.textContent ?? '', /⚠/, 'a symbol, not a colour alone')
  assert.match(sessionsButton().textContent ?? '', /graph incomplete, losses listed in the Sessions panel/, 'the button name says it')
  // Reopened from the indicator: the banner is back, the mark goes away
  await openSessions()
  await act(async () => { fireEvent.click(indicator()!.querySelector('button')!) })
  await wait(100)
  assert.ok(banner(r))
  assert.equal(sessionsMark() === null, true, 'no mark while the banner shows again')
})

// ─── #605 review, round 4: the VS Code extension's figure (no relay stream: this file's mode) ─────────────────
// The rule is stateless: the notice shows only when the view's total is ABOVE the one it was dismissed at. A lower total,
// even for a moment (a view rebuilt), never brings it back and never rewrites the stored dismissal. The relay keeps the
// stricter rule of #569: see truncation-relay.test.tsx.

/** The extension's figure, as it sends it after its reset or when a history read again reaches the page */
const figure = async (evicted: Record<string, number>) => {
  await act(async () => { post({ type: 'event-loss', evicted }) })
  await wait(100)
}
const stored = () => JSON.parse(window.sessionStorage.getItem(TRUNCATION_DISMISS_STORAGE_KEY) ?? '{}') as Record<string, number>
const NO_LOSS = { ignoredEvents: 0, malformed: 0, droppedByCap: 0, clampedFields: 0, duplicateEvents: 0 }
const statsOf = async (sid: string, stats: typeof STATS, time: number) => {
  await act(async () => { post(ev(sid, 'normalization_stats', stats, time)) })
  await wait(400)
}
const sessionRow = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('#sessions-panel [data-row-main]')).findIndex(el => (el.textContent ?? '').includes(label))

test('VS Code extension: a stored dismissal above the total keeps the notice closed; the mark on the Sessions button still names the loss', async () => {
  window.sessionStorage.setItem(TRUNCATION_DISMISS_STORAGE_KEY, JSON.stringify({ 'view:all': 100, 'sel:s1': 100 }))
  const r = await mount()
  assert.equal(banner(r) === null, true, '6 is not above 100: closed')
  assert.ok(sessionsMark(), 'the loss stays visible on the Sessions button')
  assert.deepEqual(stored(), { 'view:all': 100, 'sel:s1': 100 }, 'nothing rewritten')
})

test('VS Code extension: its figure lowered while the page is open stays dismissed; only a total above the dismissed one brings it back', async () => {
  const r = await mount()
  await figure({ s1: 4 })
  assert.ok(banner(r), '6 discarded + 4 not replayed: shown')
  await dismiss(r)
  assert.equal(banner(r) === null, true, 'dismissed at 10')
  await figure({ s1: 2 })
  assert.equal(banner(r) === null, true, '8: part of the loss already dismissed, not a new one')
  assert.equal(stored()['sel:s1'] ?? stored()['view:all'], 10, 'a lower total never rewrites the dismissal')
  await figure({ s1: 3 })
  assert.equal(banner(r) === null, true, '9: still not above 10 (the honest limit, the mark stays)')
  assert.ok(sessionsMark(), 'the mark on the Sessions button names the loss')
  await figure({ s1: 5 })
  assert.ok(banner(r), '11: above the dismissed total, a new loss: back')
})

test('R9: a view rebuilt (a new session, a total down to 4 for a moment) does not bring the notice back nor rewrite the dismissal', async () => {
  const r = await mount({ s1: STATS, s2: STATS })
  await openSessions()
  await selectRow(0)
  await figure({ s1: 4 })
  assert.ok(banner(r), 'All: 6 + 6 + 4 = 16, shown')
  await dismiss(r)
  assert.equal(stored()['view:all'], 16, 'dismissed in All at 16')
  // A new session without loss appears, and the view is rebuilt: its total falls to 4 for a moment, then is 16 again
  const now = Date.now()
  await act(async () => {
    post({ type: 'session-list', sessions: ['s1', 's2', 's3'].map(id => ({ id, label: `e2e-${id}`, status: 'active', startTime: now - 1000, lastActivityTime: now })) })
  })
  await wait(100)
  await statsOf('s1', NO_LOSS, 2)
  await statsOf('s2', NO_LOSS, 2)
  assert.equal(banner(r) === null, true, 'total 4 for a moment: closed')
  assert.equal(stored()['view:all'], 16, 'the dismissal is not rewritten at 4')
  await statsOf('s1', STATS, 3)
  await statsOf('s2', STATS, 3)
  assert.equal(banner(r) === null, true, 'back to 16: still dismissed')
  assert.equal(stored()['view:all'], 16)
})

test('R1: dismissed in All, the figure goes down while a session is open; back in All the notice stays closed', async () => {
  const r = await mount({ s1: STATS, s2: STATS })
  await openSessions()
  await selectRow(0)
  await figure({ s1: 4 })
  await dismiss(r)
  assert.equal(stored()['view:all'], 16, 'All dismissed at 16 (s1 at 10)')
  await selectRow(sessionRow('e2e-s1'))
  assert.equal(banner(r) === null, true, 's1 opens closed at 10')
  await figure({ s1: 2 })
  assert.equal(banner(r) === null, true, 's1 at 8: closed')
  await selectRow(0)
  assert.equal(banner(r) === null, true, 'All at 14, under 16: closed')
  assert.equal(stored()['view:all'], 16)
  assert.equal(stored()['sel:s1'], 10)
})

test('R2: the figure goes down in All, then a session it counted is opened: closed there too', async () => {
  const r = await mount({ s1: STATS, s2: STATS })
  await openSessions()
  await selectRow(0)
  await figure({ s1: 4 })
  await dismiss(r)
  await figure({ s1: 2 })
  assert.equal(banner(r) === null, true, 'All at 14: closed')
  await selectRow(sessionRow('e2e-s1'))
  assert.equal(banner(r) === null, true, 's1 at 8, dismissed at 10 by the All dismissal: closed')
  assert.equal(stored()['sel:s1'], 10)
})

test('R3: shown after a rise, then the total falls back under the dismissed one: the notice goes, the focus inside it goes to the Sessions button, nothing is announced', async () => {
  const r = await mount()
  await figure({ s1: 4 })
  await dismiss(r)
  await figure({ s1: 6 })
  assert.ok(banner(r), '12 above 10: shown')
  const details = r.getByRole('button', { name: 'Details' })
  details.focus()
  assert.equal(document.activeElement === details, true)
  await figure({ s1: 3 })
  assert.equal(banner(r) === null, true, '9, not above 10: the notice goes without a gesture')
  assert.equal(document.activeElement === sessionsButton(), true, `the focus is on the Sessions button, not ${document.activeElement?.tagName}`)
  assert.equal(stored()['sel:s1'] ?? stored()['view:all'], 10, 'the dismissal is not rewritten')
  const announcer = Array.from(document.querySelectorAll('[role="status"]')).find(el => el.textContent?.includes('Graph incomplete or truncated'))
  assert.equal(announcer, undefined, 'nothing announced once the notice is gone')
})

test('entering full screen with the focus inside the notice: the focus lands on Exit full screen, not on <body> (#613)', async () => {
  const r = await mount()
  assert.ok(banner(r))
  const details = r.getByRole('button', { name: 'Details' })
  details.focus()
  assert.equal(document.activeElement === details, true)
  // The Z shortcut, from inside the notice: the notice unmounts (it is not drawn in full screen) while the top bar hides
  await act(async () => { fireEvent.keyDown(details, { key: 'z' }) })
  await wait(100)
  assert.equal(banner(r) === null, true, 'no banner in full screen')
  const exit = r.getByRole('button', { name: 'Exit full screen' })
  assert.equal(document.activeElement === exit, true, `the focus is on Exit full screen, not ${document.activeElement?.tagName} ${document.activeElement?.textContent}`)
})

test('a total falling back while the focus is elsewhere does not move it', async () => {
  const r = await mount()
  await figure({ s1: 4 })
  await dismiss(r)
  await figure({ s1: 6 })
  assert.ok(banner(r))
  const sessions = sessionsButton()
  // More stands for any control of the bar away from Sessions (Enter full screen is behind it, one-line bar)
  const enter = document.getElementById('topbar-more')!
  enter.focus()
  await figure({ s1: 3 })
  assert.equal(banner(r) === null, true)
  assert.equal(document.activeElement === enter, true, 'the focus stays where the user left it')
  assert.notEqual(document.activeElement, sessions)
})

test('remount with the figure at 0 for a moment: the dismissal stored for the tab is kept', async () => {
  const first = await mount()
  await figure({ s1: 4 })
  await dismiss(first)
  const key = Object.keys(stored()).find(k => stored()[k] === 10)
  assert.ok(key, `dismissed at 10 (${JSON.stringify(stored())})`)
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore()
  await figure({})
  const again = await mount()
  assert.equal(stored()[key!], 10, 'the 0 and the 6 of the remount did not rewrite it')
  await figure({ s1: 4 })
  assert.equal(banner(again) === null, true, 'back to 10: still dismissed')
  assert.equal(stored()[key!], 10)
})

test('StrictMode: a lower total does not bring the notice back nor rewrite the dismissal', async () => {
  const r = render(<React.StrictMode><AgentVisualizer /></React.StrictMode>)
  const now = Date.now()
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [{ id: 's1', label: 'e2e-s1', status: 'active', startTime: now - 1000, lastActivityTime: now }] })
  })
  await wait(100)
  await act(async () => { post(ev('s1', 'agent_spawn', { name: 'main-s1', isMain: true }, 0)); post(ev('s1', 'normalization_stats', STATS, 1)) })
  await wait(400)
  await figure({ s1: 4 })
  assert.ok(banner(r), '10: shown')
  await dismiss(r)
  const before = window.sessionStorage.getItem(TRUNCATION_DISMISS_STORAGE_KEY)
  await figure({ s1: 1 })
  await statsOf('s1', NO_LOSS, 2)
  await statsOf('s1', STATS, 3)
  assert.equal(banner(r) === null, true, 'closed through the fall and the return')
  assert.equal(window.sessionStorage.getItem(TRUNCATION_DISMISS_STORAGE_KEY), before, 'storage untouched')
})

test('no frame of notice nor announcement while the total goes down (MutationRecords)', async () => {
  const r = await mount()
  await figure({ s1: 4 })
  await dismiss(r)
  assert.equal(banner(r) === null, true)
  const ANNOUNCE = 'Graph incomplete or truncated'
  const records: MutationRecord[] = []
  const observer = new MutationObserver(list => { records.push(...list) })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  try {
    await figure({ s1: 2 })
    await statsOf('s1', NO_LOSS, 2)
    await figure({ s1: 1 })
    await statsOf('s1', STATS, 3)
    await figure({ s1: 4 })
  } finally {
    records.push(...observer.takeRecords())
    observer.disconnect()
  }
  const bannerAdded = records.some(m => Array.from(m.addedNodes).some(n =>
    n instanceof Element && (n.matches('[data-truncation-banner]') || n.querySelector('[data-truncation-banner]') !== null)))
  assert.equal(bannerAdded, false, 'no notice node was ever added')
  const announced = records.some(m =>
    (m.type === 'characterData' && (m.target.textContent ?? '').includes(ANNOUNCE)) ||
    Array.from(m.addedNodes).some(n => (n.textContent ?? '').includes(ANNOUNCE)))
  assert.equal(announced, false, 'the live region never received the announcement')
  assert.ok(records.length > 0, 'precondition: the page did render during the fall')
})

test('leaving full screen does not take the focus back to Details after a reopen from the indicator', async () => {
  const r = await mount()
  await dismiss(r)
  await openSessions()
  await act(async () => { fireEvent.click(indicator()!.querySelector('button')!) })
  await wait(100)
  assert.equal(document.activeElement === r.getByRole('button', { name: 'Details' }), true, 'the reopen itself focuses Details')
  const enter = inMore(() => r.getByRole('button', { name: 'Enter full screen' }))
  enter.focus()
  await act(async () => { fireEvent.click(enter) })
  await waitFor(() => banner(r) === null)
  assert.equal(banner(r) === null, true, 'no banner in full screen')
  // Every focus move while leaving: Details must not take it, even for a moment (a screen reader announces each move)
  const focused: string[] = []
  const onFocusIn = (e: FocusEvent) => focused.push((e.target as HTMLElement).textContent ?? '')
  document.addEventListener('focusin', onFocusIn)
  try {
    await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Exit full screen' })) })
    await waitFor(() => banner(r) !== null)
  } finally { document.removeEventListener('focusin', onFocusIn) }
  assert.ok(banner(r), 'the banner is back after full screen')
  assert.equal(document.activeElement === r.getByRole('button', { name: 'Details' }), false, 'the focus is not on Details')
  assert.equal(focused.includes('Details'), false, `Details never took the focus while leaving full screen (${JSON.stringify(focused)})`)
})

test('the banner coming back for another reason (its total fell to 0, then a loss again) does not take the focus either', async () => {
  const r = await mount()
  await dismiss(r)
  await openSessions()
  await act(async () => { fireEvent.click(indicator()!.querySelector('button')!) })
  await wait(100)
  const sessions = sessionsButton()
  sessions.focus()
  // The session's counters drop to nothing (graph reloaded): no banner; then a loss again: the banner is back
  await act(async () => { post(ev('s1', 'normalization_stats', { ignoredEvents: 0, malformed: 0, droppedByCap: 0, clampedFields: 0, duplicateEvents: 0 }, 2)) })
  await waitFor(() => banner(r) === null)
  assert.equal(banner(r) === null, true, 'nothing lost: no banner')
  await act(async () => { post(ev('s1', 'normalization_stats', STATS, 3)) })
  await waitFor(() => banner(r) !== null)
  assert.ok(banner(r), 'a loss again: the banner shows')
  assert.equal(document.activeElement === sessions, true, 'the focus stays where the user left it')
})
