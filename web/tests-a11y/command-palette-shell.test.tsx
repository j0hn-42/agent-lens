// #243: mount the REAL AgentVisualizer and check that Ctrl+K opens the palette, that it lists what the
// bridge knows, and that its entries act on the app. Each test fails when the wiring it guards is removed.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

afterEach(() => { cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore() })

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const info = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  id, label, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: `/w/${label}`, runtime: 'claude', ...over,
})
const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

async function mount() {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions: [info('sa', 'payments-api', { branch: 'feat/refund' }), info('sb', 'web-app')] })
  })
  await wait()
  return r
}

const ctrlK = (target: Element = document.body) => act(async () => { fireEvent.keyDown(target, { key: 'k', ctrlKey: true }) })
const field = (r: ReturnType<typeof render>) => r.getByRole('combobox', { name: /search/i })

test('Ctrl+K opens the palette with the sessions of the bridge, Escape closes it', async () => {
  const r = await mount()
  assert.equal(r.queryByRole('dialog', { name: 'Command palette' }), null)
  await ctrlK()
  r.getByRole('dialog', { name: 'Command palette' })
  r.getByRole('option', { name: /payments-api/ })
  r.getByRole('option', { name: /web-app/ })
  await act(async () => { fireEvent.keyDown(field(r), { key: 'Escape' }) })
  assert.equal(r.queryByRole('dialog', { name: 'Command palette' }), null)
})

test('Ctrl+K again closes the palette', async () => {
  const r = await mount()
  await ctrlK()
  await ctrlK(field(r))
  assert.equal(r.queryByRole('dialog', { name: 'Command palette' }), null)
})

test('jumping to a session selects it', async () => {
  const r = await mount()
  await ctrlK()
  await act(async () => { fireEvent.change(field(r), { target: { value: 'payments' } }) })
  await act(async () => { fireEvent.keyDown(field(r), { key: 'Enter' }) })
  await wait(100)
  assert.equal(r.queryByRole('dialog', { name: 'Command palette' }), null)
  r.getByRole('button', { name: /^Sessions: payments-api/ })
})

test('a panel entry opens that panel', async () => {
  const r = await mount()
  await ctrlK()
  await act(async () => { fireEvent.change(field(r), { target: { value: 'timeline panel' } }) })
  await act(async () => { fireEvent.keyDown(field(r), { key: 'Enter' }) })
  await wait(100)
  r.getByRole('button', { name: /^Timeline/, pressed: true })
})

test('the shortcuts and settings entries open their dialogs', async () => {
  const r = await mount()
  await ctrlK()
  await act(async () => { fireEvent.change(field(r), { target: { value: 'keyboard shortcuts' } }) })
  await act(async () => { fireEvent.keyDown(field(r), { key: 'Enter' }) })
  r.getByRole('dialog', { name: 'Keyboard shortcuts' })
})

test('Ctrl+K does not open the palette over another dialog', async () => {
  const r = await mount()
  await ctrlK()
  await act(async () => { fireEvent.change(field(r), { target: { value: 'keyboard shortcuts' } }) })
  await act(async () => { fireEvent.keyDown(field(r), { key: 'Enter' }) })
  const dialog = r.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await ctrlK(dialog)
  assert.equal(r.queryByRole('dialog', { name: 'Command palette' }), null)
})
