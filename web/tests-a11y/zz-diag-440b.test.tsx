// TEMPORARY diagnostic for #440 (removed before review): the 4 renderHook tests of pause-switch-events, then the
// start of its visualizer scenario, 10 times. Logs the bridge listeners and the state at the click; the scenario asserts nothing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { renderHook, render, act, cleanup } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import { AgentVisualizer } from '@/components/agent-visualizer'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

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
})
afterEach(() => {
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore()
  window.HTMLCanvasElement.prototype.getContext = realGetContext
})

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const ev = (sessionId: string, time: number, type = 'agent_activity') => ({
  type: 'agent-event', event: { time, type, payload: { name: `main-${sessionId}`, isMain: true }, sessionId },
})
const info = (id: string) => ({ id, label: id, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now() })
const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

for (let k = 0; k < 10; k++) {
  test(`hook 1 ${k}`, () => {
    const { result } = renderHook(() => useVSCodeBridge())
    act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }); post(ev('b', 1, 'agent_spawn')); post(ev('b', 2)) })
    act(() => { result.current.selectSession('b') })
    act(() => { result.current.flushSessionEvents('b') })
    act(() => { result.current.consumeEvents() })
    act(() => { post(ev('b', 3)); post(ev('b', 4)) })
    assert.equal(result.current.pendingEvents.length, 2)
    act(() => { result.current.selectSession('a') })
    act(() => { result.current.flushSessionEvents('a') })
    act(() => { post(ev('b', 5)) })
    act(() => { result.current.selectSession('b') })
    act(() => { result.current.flushSessionEvents('b', 2) })
  })

  test(`hook 2 ${k}`, () => {
    const { result } = renderHook(() => useVSCodeBridge())
    act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }); post(ev('b', 1, 'agent_spawn')) })
    act(() => { result.current.selectSession('b') })
    act(() => { result.current.flushSessionEvents('b') })
    act(() => { result.current.consumeEvents() })
    act(() => { result.current.selectSession('a') })
    act(() => { post(ev('b', 2)) })
    act(() => { result.current.flushSessionEvents('a') })
  })

  test(`hook 3 ${k}`, () => {
    const { result } = renderHook(() => useVSCodeBridge())
    act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }); post(ev('a', 1, 'agent_spawn')); post(ev('b', 2, 'agent_spawn')) })
    act(() => { result.current.selectSession(ALL_SESSIONS_ID) })
    act(() => { result.current.flushSessionEvents(ALL_SESSIONS_ID) })
    act(() => { result.current.consumeEvents() })
    act(() => { post(ev('a', 3)); post(ev('b', 4)) })
    act(() => { result.current.selectSession('a') })
  })

  test(`hook 4 ${k}`, () => {
    const { result } = renderHook(() => useVSCodeBridge())
    act(() => { post({ type: 'session-list', sessions: [info('a'), info('b')] }); post(ev('b', 1, 'agent_spawn')); post(ev('b', 2)) })
    act(() => { result.current.selectSession('b') })
    act(() => { result.current.flushSessionEvents('b') })
    act(() => { result.current.selectSession('a') })
  })

  test(`diag440b scenario ${k}`, async () => {
    const b = vscodeBridge as any
    const listeners = `ev=${b.eventListeners.length} sess=${b.sessionListeners.length} init=${b.initListeners.length} isVSCode=${b.isVSCode}`
    const t0 = Date.now()
    const r = render(<AgentVisualizer />)
    let ba = 0
    await act(async () => {
      post({ type: '__vscode-bridge-init' })
      const sessions = [info('a'), info('b')]
      ba = sessions[1].lastActivityTime - sessions[0].lastActivityTime
      post({ type: 'session-list', sessions })
    })
    await wait(100)
    const sel = r.getByRole('button', { name: /^Sessions:/ }).textContent
    await act(async () => { post(ev('a', 1, 'agent_spawn')); post(ev('b', 1, 'agent_spawn')) })
    await act(async () => { post({ type: 'agent-event', event: { time: 2, type: 'message', payload: { agent: 'main-a', role: 'assistant', content: 'hello' }, sessionId: 'a' } }) })
    await wait(300)
    const review = () => r.getByRole('button', { name: 'Pause and review history' }).getAttribute('aria-disabled')
    const body = () => document.body.textContent ?? ''
    const seen = () => `mainA=${body().includes('main-a')} mainB=${body().includes('main-b')} hello=${body().includes('hello')}`
    const at300 = review()
    const seen300 = seen()
    const elapsed = Date.now() - t0
    await wait(2000)
    console.log(`[diag440b] k=${k} ${listeners} b-a=${ba} sel=${JSON.stringify(sel)} elapsed=${elapsed} disabled@300=${at300} ${seen300} disabled@2300=${review()} ${seen()}`)
  })
}
