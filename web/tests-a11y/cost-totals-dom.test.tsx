// #555 (head copied from loss-qualified-wiring.test.tsx): the whole chain, as the product wires it. The relay's `event-loss` message reaches the REAL AgentVisualizer through
// the real bridge (fake EventSource), and the three places that read numbers must carry the qualifier: the spoken totals
// of the top bar, the outline of the graph (screen readers) and the text the canvas draws. Unit tests feed `replayLost`
// by hand; this one fails when any link of the chain (index.tsx, canvas props, draw loop, a11y mirror) is not wired.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { PANEL_BUTTON_IDS } from '@/components/agent-visualizer/top-bar'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import { setLocaleChoice } from '@/lib/locale'
import axe from 'axe-core'

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
let drawn: string[] = []

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = env[k]
  env.AGENT_LENS_STANDALONE = '1'
  env.NEXT_PUBLIC_RELAY_PORT = '4321'
  FakeES.all = []; drawn = []
  g.EventSource = FakeES
  g.fetch = async () => ({ ok: false })
  const ctx: any = new Proxy({ canvas: { width: 1000, height: 700, offsetWidth: 1000 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 })
      if (k === 'fillText') return (s: string) => { drawn.push(String(s)) }
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never
})
afterEach(() => {
  cleanup(); document.body.replaceChildren(); resetDefaultUiPreferencesStore(); setLocaleChoice('auto'); window.localStorage.clear()
  window.HTMLCanvasElement.prototype.getContext = realGetContext
  g.fetch = realFetch
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete env[k]; else env[k] = savedEnv[k] }
})

const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const ev = (sessionId: string, type: string, payload: Record<string, unknown>, time = 1) =>
  ({ type: 'agent-event', event: { time, type, sessionId, payload } })

/** One session with one agent that used a tool and has a context size; `lost` = the relay's event-loss message (null: none sent) */
async function mount(lost: Record<string, number> | null, openCost = true) {
  const r = render(<AgentVisualizer />)
  const now = Date.now()
  await act(async () => { FakeES.last.open() })
  if (lost) await act(async () => { FakeES.last.send({ type: 'event-loss', evicted: lost, otherEvents: 0 }) })
  await act(async () => {
    FakeES.last.send({ type: 'session-list', sessions: [{ id: 's1', label: 'proj', status: 'active', startTime: now - 1000, lastActivityTime: now, workspace: '/w/proj', runtime: 'claude' }] })
  })
  await wait(150)
  // The 'All sessions' row, like a user: the view that receives the events
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /^Sessions ?:/ })) })
  await wait(100)
  await act(async () => { fireEvent.click(r.container.querySelectorAll<HTMLElement>('[data-row-main]')[0]) })
  await wait(100)
  await act(async () => {
    FakeES.last.send(ev('s1', 'agent_spawn', { name: 'main', isMain: true }, 0))
    FakeES.last.send(ev('s1', 'tool_call_start', { agent: 'main', tool: 'Bash', toolUseId: 't1', args: 'ls' }, 2))
    FakeES.last.send(ev('s1', 'tool_call_end', { agent: 'main', tool: 'Bash', toolUseId: 't1', result: 'ok' }, 3))
    // After the tool: an absolute context reading clears the gap a tool without a reported cost leaves, so the totals are complete
    FakeES.last.send(ev('s1', 'context_update', { agent: 'main', tokens: 120_000, tokenSource: 'reported' }, 4))
  })
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /Hide inactive agents|Masquer les agents inactifs/ })) }) // idle agents are hidden by default
  // The two canvas texts that carry numbers: the stats under each agent, and the Cost panel
  await act(async () => { fireEvent.click(document.getElementById(PANEL_BUTTON_IDS.stats)!) })
  if (openCost) await act(async () => { fireEvent.click(document.getElementById(PANEL_BUTTON_IDS.cost)!) })
  await wait(700)
  return r
}
const spoken = (r: ReturnType<typeof render>) => r.container.querySelector('[data-testid="topbar-spoken-totals"]')?.textContent ?? ''
const panel = (r: ReturnType<typeof render>) => r.container.querySelector<HTMLElement>('[data-testid="cost-panel-totals"]')

test('Cost panel open, no loss: a named region holds the totals as text, in English', async () => {
  const r = await mount(null)
  const p = panel(r)
  assert.ok(p, 'the Cost panel carries its totals in the DOM')
  assert.equal(p.getAttribute('role'), 'region')
  assert.equal(p.getAttribute('aria-label'), 'Cost totals')
  assert.equal(p.getAttribute('lang'), 'en')
  assert.match(p.textContent ?? '', /estimate of context cost|context cost/i)
  assert.match(p.textContent ?? '', /120k tokens in context/)
  assert.doesNotMatch(p.textContent ?? '', /at least/)
})

test('Cost panel open, events lost: the DOM totals say "at least", like the drawing', async () => {
  const r = await mount({ s1: 7 })
    assert.ok(drawn.some(t => /^at least .* ctx tokens$/.test(t)), `canvas header: ${JSON.stringify(drawn)}`)
  assert.match(panel(r)?.textContent ?? '', /at least/)
})

test('French: the region, its name and the qualifiers are French, lang declared', async () => {
  setLocaleChoice('fr')
  const r = await mount({ s1: 7 })
  const p = panel(r)
  assert.ok(p)
  assert.equal(p.getAttribute('lang'), 'fr')
  assert.equal(p.getAttribute('aria-label'), 'Totaux du coût')
  assert.match(p.textContent ?? '', /au moins/)
  assert.match(p.textContent ?? '', /jetons dans le contexte/)
  assert.doesNotMatch(p.textContent ?? '', /at least|tokens in context/)
})

test('Cost panel closed: no region, and the top bar still reads the totals (the only place without a panel)', async () => {
  const r = await mount(null, false)
  assert.equal(panel(r), null)
  assert.match(spoken(r), /120k tokens in context/)
})

test('the totals of the region equal the top bar wording (same function, same figures)', async () => {
  const r = await mount({ s1: 7 })
  const bar = spoken(r)
  const p = panel(r)?.textContent ?? ''
  assert.notEqual(p, '', 'the region has text')
  for (const part of p.split(', ')) assert.ok(bar.includes(part), `"${part}" is in the bar text "${bar}"`)
})

test('axe: the Cost totals region has no violation', async () => {
  const r = await mount({ s1: 7 })
  const results = await axe.run(panel(r)!.parentElement ?? panel(r)!)
  assert.deepEqual(results.violations.map(v => v.id), [])
})
