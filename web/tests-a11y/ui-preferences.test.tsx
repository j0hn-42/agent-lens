// useUiPreferences (#32): SSR safety, cross-tab sync, write batching; Escape stack through React hooks; focus return.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { act, useRef, useState } from 'react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { useUiPreferences, createBrowserPrefsStore } from '@/hooks/use-ui-preferences'
import { PanelRegistryContext, createPanelRegistry, usePanelRegistration } from '@/hooks/use-panel-registry'
import { useFocusReturn } from '@/hooks/use-focus-return'
import { UI_PREFS_STORAGE_KEY, serializePrefs, DEFAULT_UI_PREFS, type PrefsStore } from '@/lib/ui-preferences'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

beforeEach(() => { window.localStorage.clear() })
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  window.localStorage.clear()
})

function Probe({ store }: { store: PrefsStore }) {
  const { prefs, setPref, resetPrefs } = useUiPreferences(store)
  return (
    <div>
      <output data-testid="hex">{String(prefs.showHexGrid)}</output>
      <output data-testid="stats">{String(prefs.showStats)}</output>
      <output data-testid="width">{prefs.dockRightWidth}</output>
      <button onClick={() => setPref('showStats', !prefs.showStats)}>stats</button>
      <button onClick={() => { setPref('showTimeline', true); setPref('showFiles', true); setPref('dockRightWidth', 99999) }}>burst</button>
      <button onClick={resetPrefs}>reset</button>
    </div>
  )
}

test('SSR: the server render uses defaults even when storage holds values; hydration adopts them with no mismatch', async () => {
  window.localStorage.setItem(UI_PREFS_STORAGE_KEY, serializePrefs({ ...DEFAULT_UI_PREFS, showHexGrid: false, showStats: true, dockRightWidth: 500 }))
  const store = createBrowserPrefsStore()
  const html = renderToString(<Probe store={store} />)
  assert.match(html, /data-testid="hex">true</, 'server render = defaults')
  assert.match(html, /data-testid="stats">false</)
  assert.match(html, /data-testid="width">380</)

  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  const errors: unknown[][] = []
  const origError = console.error
  console.error = (...a: unknown[]) => { errors.push(a) }
  try {
    const recoverable: unknown[] = []
    let root!: ReturnType<typeof hydrateRoot>
    await act(async () => { root = hydrateRoot(container, <Probe store={store} />, { onRecoverableError: e => recoverable.push(e) }) })
    await act(async () => { await sleep(10) })
    assert.deepEqual(recoverable, [], 'no hydration mismatch')
    assert.deepEqual(errors, [], 'no React warning')
    assert.equal(container.querySelector('[data-testid=hex]')!.textContent, 'false', 'stored value applied after mount')
    assert.equal(container.querySelector('[data-testid=stats]')!.textContent, 'true')
    assert.equal(container.querySelector('[data-testid=width]')!.textContent, '500')
    act(() => root.unmount())
  } finally {
    console.error = origError
  }
})

test('cross-tab: a storage event from another tab updates the UI; foreign keys are ignored; no write-back', async () => {
  const store = createBrowserPrefsStore()
  const { getByTestId } = render(<Probe store={store} />)
  const proto = window.Storage.prototype
  const setItem = proto.setItem
  const writes: string[] = []
  proto.setItem = function (this: Storage, k: string, v: string) { writes.push(k); setItem.call(this, k, v) }
  try {
    const next = serializePrefs({ ...DEFAULT_UI_PREFS, showStats: true })
    act(() => { window.dispatchEvent(new window.StorageEvent('storage', { key: 'something-else', newValue: next })) })
    assert.equal(getByTestId('stats').textContent, 'false', 'other keys are ignored')
    act(() => { window.dispatchEvent(new window.StorageEvent('storage', { key: UI_PREFS_STORAGE_KEY, newValue: next })) })
    assert.equal(getByTestId('stats').textContent, 'true')
    act(() => { window.dispatchEvent(new window.StorageEvent('storage', { key: UI_PREFS_STORAGE_KEY, newValue: '{"__proto__":{"showHexGrid":false}}' })) })
    assert.equal(getByTestId('hex').textContent, 'true', 'hostile payload falls back to defaults')
    await act(async () => { await sleep(40) })
    assert.deepEqual(writes, [], 'adopting another tab state must not write back')
  } finally {
    proto.setItem = setItem
  }
})

test('pagehide flushes a pending write at once (the frame that would have written it never comes)', async () => {
  const store = createBrowserPrefsStore()
  const { getByRole } = render(<Probe store={store} />)
  fireEvent.click(getByRole('button', { name: 'stats' }))
  assert.equal(window.localStorage.getItem(UI_PREFS_STORAGE_KEY), null, 'batched: nothing written yet')
  act(() => { window.dispatchEvent(new window.Event('pagehide')) })
  assert.equal(JSON.parse(window.localStorage.getItem(UI_PREFS_STORAGE_KEY)!).prefs.showStats, true, 'written synchronously by pagehide')
})

test('cross-tab: localStorage.clear() in another tab (storage event with key null) resets this tab to the defaults', () => {
  const store = createBrowserPrefsStore()
  const { getByTestId } = render(<Probe store={store} />)
  const next = serializePrefs({ ...DEFAULT_UI_PREFS, showStats: true })
  act(() => { window.dispatchEvent(new window.StorageEvent('storage', { key: UI_PREFS_STORAGE_KEY, newValue: next })) })
  assert.equal(getByTestId('stats').textContent, 'true')
  act(() => { window.dispatchEvent(new window.StorageEvent('storage', { key: null, newValue: null })) })
  assert.equal(getByTestId('stats').textContent, 'false')
})

test('batching: several setPref calls in one handler write localStorage exactly once, with the final state', async () => {
  const store = createBrowserPrefsStore()
  const { getByRole, getByTestId } = render(<Probe store={store} />)
  const proto = window.Storage.prototype
  const original = proto.setItem
  const writes: string[] = []
  proto.setItem = function (this: Storage, k: string, v: string) { writes.push(v); original.call(this, k, v) }
  try {
    fireEvent.click(getByRole('button', { name: 'burst' }))
    assert.equal(writes.length, 0, 'nothing written synchronously')
    assert.equal(getByTestId('width').textContent, '720', 'UI updates immediately, clamped')
    await act(async () => { await sleep(60) })
    assert.equal(writes.length, 1)
    const saved = JSON.parse(writes[0]).prefs
    assert.equal(saved.showTimeline, true); assert.equal(saved.showFiles, true); assert.equal(saved.dockRightWidth, 720)
  } finally {
    proto.setItem = original
  }
})

test('toggle then reset round-trips through storage', async () => {
  const store = createBrowserPrefsStore()
  const { getByRole, getByTestId } = render(<Probe store={store} />)
  fireEvent.click(getByRole('button', { name: 'stats' }))
  await act(async () => { await sleep(60) })
  assert.equal(JSON.parse(window.localStorage.getItem(UI_PREFS_STORAGE_KEY)!).prefs.showStats, true)
  fireEvent.click(getByRole('button', { name: 'reset' }))
  await act(async () => { await sleep(60) })
  assert.equal(getByTestId('stats').textContent, 'false')
  assert.equal(window.localStorage.getItem(UI_PREFS_STORAGE_KEY), null)
})

// --- Escape stack through the React hook -------------------------------------------------------

function EscPanel({ id, initiallyOpen = true, log }: { id: string; initiallyOpen?: boolean; log: string[] }) {
  const [open, setOpen] = useState(initiallyOpen)
  usePanelRegistration(id, () => { if (!open) return false; setOpen(false); log.push(id); return true })
  return open ? <div data-testid={id}>{id}</div> : null
}

function Stack({ ids, log, registry }: { ids: string[]; log: string[]; registry: ReturnType<typeof createPanelRegistry> }) {
  return (
    <PanelRegistryContext.Provider value={registry.register}>
      {ids.map(id => <EscPanel key={id} id={id} log={log} />)}
    </PanelRegistryContext.Provider>
  )
}

test('Escape stack via hooks: panels mounted later close first, one per Escape; unmounting mid-stack works', () => {
  const registry = createPanelRegistry()
  const log: string[] = []
  const { queryByTestId, rerender } = render(<Stack ids={['a', 'b', 'c']} log={log} registry={registry} />)
  assert.deepEqual(registry.ids(), ['a', 'b', 'c'])
  act(() => { registry.escape() })
  assert.deepEqual(log, ['c'])
  assert.ok(queryByTestId('a') && queryByTestId('b') && !queryByTestId('c'), 'only one panel closed')
  rerender(<Stack ids={['a', 'c']} log={log} registry={registry} />) // b unmounted mid-stack
  assert.deepEqual(registry.ids(), ['a', 'c'])
  act(() => { registry.escape() }) // c is already closed: falls through to a
  assert.deepEqual(log, ['c', 'a'])
  act(() => { assert.equal(registry.escape(), false) })
})

test('usePanelRegistration calls the latest handler without re-registering (stack position is kept)', () => {
  const registry = createPanelRegistry()
  const calls: string[] = []
  function P({ id, tag }: { id: string; tag: string }) {
    usePanelRegistration(id, () => { calls.push(tag); return true })
    return null
  }
  const { rerender } = render(
    <PanelRegistryContext.Provider value={registry.register}><P id="a" tag="a1" /><P id="b" tag="b1" /></PanelRegistryContext.Provider>,
  )
  rerender(<PanelRegistryContext.Provider value={registry.register}><P id="a" tag="a2" /><P id="b" tag="b2" /></PanelRegistryContext.Provider>)
  assert.deepEqual(registry.ids(), ['a', 'b'])
  registry.escape()
  assert.deepEqual(calls, ['b2'])
})

// --- focus return ------------------------------------------------------------------------------

function Toggled() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useFocusReturn(open, ref)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)}>trigger</button>
      <div ref={ref} style={{ display: 'contents' }}>
        {open && <section><button>first</button><button onClick={() => setOpen(false)}>close</button></section>}
      </div>
    </div>
  )
}

test('focus return: opening focuses the first control, closing gives focus back to the trigger', async () => {
  const { getByRole } = render(<Toggled />)
  const trigger = getByRole('button', { name: 'trigger' })
  trigger.focus()
  fireEvent.click(trigger)
  await act(async () => { await sleep(20) })
  assert.equal(document.activeElement, getByRole('button', { name: 'first' }))
  fireEvent.click(getByRole('button', { name: 'close' }))
  await act(async () => { await sleep(20) })
  assert.equal(document.activeElement, trigger)
})
