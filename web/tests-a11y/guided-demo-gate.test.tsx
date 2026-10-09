// The guided tour belongs to the demo data: ?scenario=guided on an instance fed by a real source (relay or
// VS Code) must not hold the real event log at the steps' times. Mounts the REAL AgentVisualizer (index.tsx).
import { test, before, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'

// Web Audio is not in jsdom: a deep no-op stub
const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

// The scenario is read from the URL when the module loads: set it before importing the app
let AgentVisualizer: typeof import('@/components/agent-visualizer').AgentVisualizer
let resetDefaultUiPreferencesStore: () => void
before(async () => {
  window.history.replaceState(null, '', '/?scenario=guided')
  ;({ AgentVisualizer } = await import('@/components/agent-visualizer'))
  ;({ resetDefaultUiPreferencesStore } = await import('@/hooks/use-ui-preferences'))
})

afterEach(() => { cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore() })
const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const tourCard = (r: ReturnType<typeof render>) => r.queryByRole('dialog', { name: /./ })?.querySelector('#guided-tour-title') ?? null

test('on the demo data, ?scenario=guided starts the tour', async () => {
  const r = render(<AgentVisualizer />)
  await wait()
  assert.ok(tourCard(r), 'the tour card is shown')
})

test('once a real source takes over, ?scenario=guided neither keeps the tour nor offers it', async () => {
  const r = render(<AgentVisualizer />)
  await wait()
  await act(async () => { window.dispatchEvent(new window.MessageEvent('message', { data: { type: '__vscode-bridge-init' } })) })
  await wait()
  assert.equal(tourCard(r) !== null, false, 'no tour on the real event log')
  assert.equal(r.queryByRole('button', { name: 'Guided tour' }) !== null, false, 'no Guided tour button')
})
