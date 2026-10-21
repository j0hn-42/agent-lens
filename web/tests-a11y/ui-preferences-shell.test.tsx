// Persisted UI preferences in the REAL shell (index.tsx, issue #32): panel flags, grid, stats, cost overlay,
// the right dock width and the last selected session survive a reload; the first render equals the server
// render; the remembered session is not overwritten by the startup null or by the bridge's auto-selection.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { clearPair } from '@/lib/pair-filter-store'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import { UI_PREFS_STORAGE_KEY, serializePrefs, DEFAULT_UI_PREFS, parsePrefs, type UiPrefs } from '@/lib/ui-preferences'
import { dockStore } from '@/lib/panel-layout'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

const win = window as unknown as { innerWidth: number; innerHeight: number }

/** The dock sizes a fresh page starts from (before the stored preferences are applied). */
const resetDockSizes = () => {
  dockStore.setRightWidth(DEFAULT_UI_PREFS.dockRightWidth)
  dockStore.setLeftWidth(DEFAULT_UI_PREFS.dockLeftWidth)
  dockStore.setLeftHeight('detail', DEFAULT_UI_PREFS.detailPanelHeight)
  dockStore.setLeftHeight('system', DEFAULT_UI_PREFS.systemPanelHeight)
}

beforeEach(() => {
  clearPair()
  win.innerWidth = 1600
  win.innerHeight = 900
  resetDefaultUiPreferencesStore()
  resetDockSizes()
  act(() => dockStore.measure())
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  clearPair()
  resetDefaultUiPreferencesStore()
  resetDockSizes()
})

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const wait = (ms = 200) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const key = (k: string) => act(async () => { fireEvent.keyDown(document.body, { key: k }) })

const store = (prefs: Partial<UiPrefs>) => window.localStorage.setItem(UI_PREFS_STORAGE_KEY, serializePrefs({ ...DEFAULT_UI_PREFS, ...prefs }))
const stored = (): UiPrefs => parsePrefs(window.localStorage.getItem(UI_PREFS_STORAGE_KEY))

async function mount() {
  const r = render(<AgentVisualizer />)
  await act(async () => { post({ type: '__vscode-bridge-init' }) })
  await wait(100)
  return r
}
/** What a page reload does: a new store over the same localStorage, a new tree. */
async function reload(r: ReturnType<typeof render>) {
  await wait(60) // let the batched write land
  r.unmount()
  resetDefaultUiPreferencesStore({ keepStorage: true })
  // A new page starts from the default dock sizes, so a restored one is really read back from storage
  dockStore.setRightWidth(DEFAULT_UI_PREFS.dockRightWidth)
  dockStore.setLeftWidth(DEFAULT_UI_PREFS.dockLeftWidth)
  dockStore.setLeftHeight('detail', DEFAULT_UI_PREFS.detailPanelHeight)
  dockStore.setLeftHeight('system', DEFAULT_UI_PREFS.systemPanelHeight)
  return mount()
}

const conversationRegion = (r: ReturnType<typeof render>) => r.queryByRole('region', { name: 'Conversation' })
const filesRegion = (r: ReturnType<typeof render>) => r.queryByRole('region', { name: 'Files & repeats observed' })
const timelineRegion = (r: ReturnType<typeof render>) => r.queryByRole('region', { name: 'Execution timeline' })

test('the first render equals the server render: stored panels are applied after mount, not during hydration', async () => {
  const serverHtml = renderToString(<AgentVisualizer />)
  store({ showTimeline: true, showConversation: true, showStats: true, showHexGrid: false })
  resetDefaultUiPreferencesStore({ keepStorage: true })
  const htmlWithStoredPrefs = renderToString(<AgentVisualizer />)
  assert.ok(htmlWithStoredPrefs === serverHtml, 'server markup does not depend on localStorage')
  const r = await mount()
  assert.ok(timelineRegion(r), 'Timeline restored after mount')
  assert.ok(conversationRegion(r), 'Conversation restored after mount')
})

test('flags toggled by the user are stored and come back after a reload; speed is not stored', async () => {
  const r = await mount()
  assert.ok(timelineRegion(r) === null)
  await key('t')
  await key('g')
  await key('s')
  await key('f')
  await wait(60)
  const now = stored()
  assert.equal(now.showTimeline, true)
  assert.equal(now.showHexGrid, false, 'grid toggled off')
  assert.equal(now.showStats, true)
  assert.equal(now.showFiles, true)
  assert.ok(!('speed' in JSON.parse(window.localStorage.getItem(UI_PREFS_STORAGE_KEY)!).prefs), 'playback speed is deliberately not persisted')

  const again = await reload(r)
  assert.ok(timelineRegion(again), 'Timeline back')
  assert.ok(filesRegion(again), 'Files back')
  assert.ok(conversationRegion(again) === null, 'Conversation was not open')
  await key('f')
  assert.ok(filesRegion(again) === null, 'and still toggles')
  await wait(60)
  assert.equal(stored().showFiles, false)
})

test('the right dock width is stored on resize and applied after a reload', async () => {
  store({ showFiles: true })
  resetDefaultUiPreferencesStore({ keepStorage: true })
  const r = await mount()
  const root = () => r.container.querySelector<HTMLElement>('[data-dock-panel="files"]')!
  assert.equal(root().style.width, '380px')
  await act(async () => { fireEvent.change(r.getByRole('slider', { name: 'Resize Files & repeats panel' }), { target: { value: '520' } }) })
  assert.equal(root().style.width, '520px')
  await wait(60)
  assert.equal(stored().dockRightWidth, 520)

  const again = await reload(r)
  assert.equal(again.container.querySelector<HTMLElement>('[data-dock-panel="files"]')!.style.width, '520px', 'width restored')
})

test('a width that the viewport only clamped is not written back', async () => {
  store({ showFiles: true, dockRightWidth: 720 })
  resetDefaultUiPreferencesStore({ keepStorage: true })
  win.innerWidth = 1000 // max dock width here is 600
  act(() => dockStore.measure())
  const r = await mount()
  assert.equal(r.container.querySelector<HTMLElement>('[data-dock-panel="files"]')!.style.width, '600px', 'clamped for this window')
  await wait(100)
  assert.equal(stored().dockRightWidth, 720, 'the stored preference is kept for wider windows')
})

const session = (id: string, label: string, lastActivityTime: number) =>
  ({ id, label, status: 'active', startTime: lastActivityTime - 1000, lastActivityTime, workspace: '/w', runtime: 'claude' })
const status = (r: ReturnType<typeof render>) => r.container.querySelector('[role="status"]')!.textContent ?? ''

test('the remembered session is restored when the list arrives, not overwritten by startup or by the auto-selection', async () => {
  store({ lastSelectedSessionId: 'sb' })
  resetDefaultUiPreferencesStore({ keepStorage: true })
  const r = await mount()
  await wait(100)
  assert.equal(stored().lastSelectedSessionId, 'sb', 'mounting alone must not overwrite the stored session with null')
  // the bridge auto-selects the most recently active session ('sa') when the list arrives
  await act(async () => { post({ type: 'session-list', sessions: [session('sa', 'alpha-api', Date.now()), session('sb', 'beta-web', Date.now() - 60_000)] }) })
  await wait(300)
  assert.match(status(r), /Session: beta-web/, 'the stored session is selected')
  assert.equal(stored().lastSelectedSessionId, 'sb', 'and still stored')
})

test('a stored session that is no longer listed falls back to the bridge choice, which is then remembered', async () => {
  store({ lastSelectedSessionId: 'gone' })
  resetDefaultUiPreferencesStore({ keepStorage: true })
  const r = await mount()
  await act(async () => { post({ type: 'session-list', sessions: [session('sa', 'alpha-api', Date.now()), session('sb', 'beta-web', Date.now() - 60_000)] }) })
  await wait(300)
  assert.match(status(r), /Session: alpha-api/)
  assert.equal(stored().lastSelectedSessionId, 'sa')
})

test('the left column width and the System height are stored on resize and applied after a reload', async () => {
  const r = await mount()
  await key('y') // opens the System panel
  await wait(50)
  const root = () => r.container.querySelector<HTMLElement>('[data-dock-panel="system"]')!
  assert.equal(root().style.width, '320px', 'the column opens wider than its 240 px minimum')
  await act(async () => { fireEvent.change(r.getByRole('slider', { name: 'Resize the width of the left column' }), { target: { value: '460' } }) })
  await act(async () => { fireEvent.change(r.getByRole('slider', { name: 'Resize the height of the System panel' }), { target: { value: '480' } }) })
  assert.equal(root().style.width, '460px')
  await wait(60)
  assert.equal(stored().dockLeftWidth, 460)
  assert.equal(stored().systemPanelHeight, 480)

  const again = await reload(r)
  await key('y')
  await wait(50)
  const back = again.container.querySelector<HTMLElement>('[data-dock-panel="system"]')!
  assert.equal(back.style.width, '460px', 'width restored')
  assert.equal((again.getByRole('slider', { name: 'Resize the height of the System panel' }) as HTMLInputElement).value, '480', 'height restored')
})
