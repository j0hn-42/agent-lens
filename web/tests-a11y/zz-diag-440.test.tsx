// TEMPORARY diagnostic for #440 (removed before review): replays the start of the pause-switch scenario and logs
// which session the list auto-selected and whether Review became available. No assertion: CI logs are the output.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import React from 'react'
import { render, act, cleanup } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { AgentVisualizer } from '@/components/agent-visualizer'
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

for (let i = 0; i < 20; i++) {
  test(`diag440 iteration ${i}`, async () => {
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
    const at300 = review()
    await wait(2000)
    console.log(`[diag440] i=${i} b-a=${ba} sel=${JSON.stringify(sel)} disabled@300=${at300} disabled@2300=${review()}`)
  })
}
