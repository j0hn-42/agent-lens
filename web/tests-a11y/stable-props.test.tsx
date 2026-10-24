// #658: the memoized top of the tree really skips. The bridge object keeps its identity while no field changes, the
// top bar, the conversation panel and the panel dock are memoized and do not render for a render of their parent that
// changes none of their props.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { Profiler } from 'react'
import { render, renderHook, act, cleanup, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { ConversationPanel } from '@/components/agent-visualizer/conversation-panel'
import { PanelDock } from '@/components/agent-visualizer/panel-dock'
import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { chromeRenderProbe } from '@/lib/row-sync'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

// No demo: nothing ticks, so a render is caused by what the test does
process.env.NEXT_PUBLIC_DEMO = '0'
Object.defineProperty(globalThis, 'localStorage', { value: window.localStorage, configurable: true })
const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

afterEach(() => {
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore(); chromeRenderProbe.onRender = null
  try { localStorage.clear() } catch { /* storage unavailable */ }
})

const isMemo = (c: unknown) => (c as { $$typeof: symbol }).$$typeof === Symbol.for('react.memo')

test('ConversationPanel and PanelDock are memoized', () => {
  assert.ok(isMemo(ConversationPanel), 'ConversationPanel')
  assert.ok(isMemo(PanelDock), 'PanelDock')
})

test('the bridge object keeps its identity across renders that change none of its fields', () => {
  const { result, rerender } = renderHook(() => useVSCodeBridge())
  const first = result.current
  rerender()
  rerender()
  assert.equal(result.current, first, 'same object')
})

test('the bridge object changes when a field changes', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  const first = result.current
  act(() => { result.current.loadDemo() })
  act(() => { result.current.exitDemo() })
  assert.notEqual(result.current, first)
})

test('opening and closing a dialog renders the visualizer but neither the top bar, nor the conversation panel, nor the dock', async () => {
  const counts = { TopBar: 0, ConversationPanel: 0, PanelDock: 0 }
  chromeRenderProbe.onRender = name => { counts[name]++ }
  let commits = 0
  const view = render(<Profiler id="v" onRender={() => { commits++ }}><AgentVisualizer /></Profiler>)
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 80)) })
  await settle()
  assert.ok(counts.TopBar >= 1 && counts.ConversationPanel >= 1 && counts.PanelDock >= 1, 'the probes see the first render')
  const before = { ...counts }
  const commitsBefore = commits
  for (let i = 0; i < 3; i++) {
    await act(async () => { fireEvent.keyDown(document.body, { key: '?' }) })
    await settle()
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }) })
    await settle()
  }
  const delta = { TopBar: counts.TopBar - before.TopBar, ConversationPanel: counts.ConversationPanel - before.ConversationPanel, PanelDock: counts.PanelDock - before.PanelDock }
  console.log(`[#658] commits=${commits - commitsBefore} renders ${JSON.stringify(delta)}`)
  assert.ok(commits - commitsBefore >= 4, `the dialog commits (${commits - commitsBefore})`)
  assert.deepEqual(delta, { TopBar: 0, ConversationPanel: 0, PanelDock: 0 })
  view.unmount()
})
