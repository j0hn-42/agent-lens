// #605 review, round 4: the truncation notice with the RELAY's figure (SSE stream, fake EventSource), as AgentVisualizer
// wires it. The relay keeps the rule of #569: a dismissal holds only at the total it was made at; a LOWER total is a new
// loss (relay restarted, graph reloaded), so the notice comes back. The VS Code extension's figure follows another rule
// (only a total above the dismissed one brings it back): see truncation-dismiss.test.tsx. These tests fail if the page
// reads every figure as the extension's.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

/** The sessionStorage key the dismissals live under (lib/event-loss) */
const TRUNCATION_DISMISS_STORAGE_KEY = 'agent-lens:truncation-dismissed'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

class FakeES {
  static all: FakeES[] = []
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(public url: string) { FakeES.all.push(this) }
  close() {}
  open() { this.onopen?.({}) }
  send(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  static get last() { return FakeES.all[FakeES.all.length - 1] }
}

const g = globalThis as unknown as Record<string, unknown>
const env = process.env as Record<string, string | undefined>
const ENV_KEYS = ['AGENT_LENS_STANDALONE', 'NEXT_PUBLIC_RELAY_PORT'] as const
const savedEnv: Record<string, string | undefined> = {}
const realGetContext = window.HTMLCanvasElement.prototype.getContext
const realFetch = g.fetch

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = env[k]
  env.AGENT_LENS_STANDALONE = '1'
  env.NEXT_PUBLIC_RELAY_PORT = '4321'
  FakeES.all = []
  g.EventSource = FakeES
  g.fetch = async () => ({ ok: false })
  const ctx: any = new Proxy({ canvas: { width: 1000, height: 700, offsetWidth: 1000 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never
  try { window.sessionStorage.clear() } catch { /* nothing stored */ }
})
afterEach(() => {
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore()
  window.HTMLCanvasElement.prototype.getContext = realGetContext
  g.fetch = realFetch
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete env[k]; else env[k] = savedEnv[k] }
  try { window.sessionStorage.clear() } catch { /* nothing stored */ }
})

const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const ev = (sessionId: string, type: string, payload: Record<string, unknown>, time = 1) =>
  ({ type: 'agent-event', event: { time, type, sessionId, payload } })
const NO_LOSS = { ignoredEvents: 0, malformed: 0, droppedByCap: 0, clampedFields: 0, duplicateEvents: 0 }

/** One session s1 whose normalizer lost nothing; the relay's figure for it is `lost` (first connection) */
async function mount(lost: number) {
  const r = render(<AgentVisualizer />)
  const now = Date.now()
  await act(async () => { FakeES.last.open() })
  await act(async () => { FakeES.last.send({ type: 'event-loss', evicted: { s1: lost }, otherEvents: 0 }) })
  await act(async () => {
    FakeES.last.send({ type: 'session-list', sessions: [{ id: 's1', label: 'proj', status: 'active', startTime: now - 1000, lastActivityTime: now, workspace: '/w/proj', runtime: 'claude' }] })
  })
  await wait(150)
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /^Sessions:/ })) })
  await wait(100)
  await act(async () => { fireEvent.click(r.container.querySelectorAll<HTMLElement>('[data-row-main]')[0]) })
  await wait(100)
  await act(async () => {
    FakeES.last.send(ev('s1', 'agent_spawn', { name: 'main', isMain: true }, 0))
    FakeES.last.send(ev('s1', 'normalization_stats', NO_LOSS, 1))
  })
  await wait(400)
  return r
}
const banner = (r: ReturnType<typeof render>) => r.container.querySelector<HTMLElement>('[data-truncation-banner]')

test('relay: dismissed at 10, the relay sends 6 (a lower figure, live): the notice comes back', async () => {
  const r = await mount(10)
  assert.ok(banner(r), '10 events the relay could not replay: shown')
  await act(async () => { fireEvent.click(r.getByRole('button', { name: 'Dismiss truncation warning' })) })
  await wait(50)
  assert.equal(banner(r) === null, true, 'dismissed at 10')
  // Same first connection (a reloaded graph): the relay's new figure replaces the old one
  await act(async () => { FakeES.last.send({ type: 'event-loss', evicted: { s1: 6 }, otherEvents: 0 }) })
  await wait(150)
  assert.ok(banner(r), '6 after 10 from the relay: a new loss, the notice is back')
})

test('relay: a stale dismissal (relay restarted: the total is now lower than the one dismissed at) does not hide a new loss', async () => {
  // Dismissed at 100 in this tab before the relay restarted; the new relay's graph lost 6
  window.sessionStorage.setItem(TRUNCATION_DISMISS_STORAGE_KEY, JSON.stringify({ 'view:all': 100, 'sel:s1': 100 }))
  const r = await mount(6)
  assert.ok(banner(r), 'a lower total is a new loss: the banner shows')
})
