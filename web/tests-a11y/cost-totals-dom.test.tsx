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
import { CostTotalsText } from '@/components/agent-visualizer/cost-totals-text'
import { PANEL_BUTTON_IDS } from '@/components/agent-visualizer/top-bar'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'
import { setLocaleChoice } from '@/lib/locale'
import axe from 'axe-core'
import { closeMore, pressInMore } from './topbar-more'
import { waitFor } from './wait-for'

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

/** Events of the default fixture: one agent that used a tool and has a context size */
const TOOL_AND_CONTEXT = [
  ev('s1', 'agent_spawn', { name: 'main', isMain: true }, 0),
  ev('s1', 'tool_call_start', { agent: 'main', tool: 'Bash', toolUseId: 't1', args: 'ls' }, 2),
  ev('s1', 'tool_call_end', { agent: 'main', tool: 'Bash', toolUseId: 't1', result: 'ok' }, 3),
  // After the tool: an absolute context reading clears the gap a tool without a reported cost leaves, so the totals are complete
  ev('s1', 'context_update', { agent: 'main', tokens: 120_000, tokenSource: 'reported' }, 4),
]
/**
 * Usage that belongs to no agent (the unattributed row of the drawing), for an agent the graph does not know. A tool cost
 * with no reported source is an estimate; a context reading is not.
 */
const ORPHAN = ev('s1', 'tool_call_end', { agent: 'ghost', tool: 'Bash', toolUseId: 'g1', result: 'ok', tokenCost: 900_000 }, 5)
const ORPHAN_READING = ev('s1', 'context_update', { agent: 'ghost', tokens: 900_000 }, 5)

/**
 * One session; `lost` = the relay's event-loss message (null: none sent). `row` 0 is the 'All sessions' row, 1 the session
 * itself (single-session mode). `events` defaults to one agent that used a tool and has a context size.
 */
async function mount(lost: Record<string, number> | null, openCost = true, { row = 0, events = TOOL_AND_CONTEXT }: { row?: number; events?: unknown[] } = {}) {
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
  const rows = r.container.querySelectorAll<HTMLElement>('[data-row-main]')
  assert.ok(rows[row], `session row ${row} exists`)
  // The only session is selected on its own (single-session mode): its row is only clicked when it is not the current one
  if (rows[row].getAttribute('aria-current') !== 'true') await act(async () => { fireEvent.click(rows[row]) })
  else await act(async () => { fireEvent.click(r.getByRole('button', { name: /^Sessions ?:/ })) }) // close the panel, as the click would
  await wait(100)
  await act(async () => { for (const e of events) FakeES.last.send(e) })
  await pressInMore(() => r.getByRole('button', { name: /^Hide inactive|^Masquer les inactifs/ })); closeMore() // idle agents are hidden by default
  // The two canvas texts that carry numbers: the stats under each agent, and the Cost panel
  await act(async () => { fireEvent.click(document.getElementById(PANEL_BUTTON_IDS.stats)!) })
  if (openCost) await act(async () => { fireEvent.click(document.getElementById(PANEL_BUTTON_IDS.cost)!) })
  // #440: the events reach the view with the simulation's throttled UI commit and the canvas draws them on a later frame
  // (setTimeout(0) here): wait until the top bar counts the agent and a frame has drawn it, not a fixed time a loaded runner overruns
  drawn = []
  await waitFor(() => /\b[1-9]\d* agents?\b/.test(spoken(r)) && drawn.some(t => /main/.test(t)))
  return r
}
const spoken = (r: ReturnType<typeof render>) => r.container.querySelector('[data-testid="topbar-spoken-totals"]')?.textContent ?? ''
const panel = (r: ReturnType<typeof render>) => r.container.querySelector<HTMLElement>('[data-testid="cost-panel-totals"]')

test('Cost panel open, no loss: a named region holds the totals as text, in English', async () => {
  const r = await mount(null)
  const p = panel(r)
  assert.ok(p, 'the Cost panel carries its totals in the DOM')
  assert.equal(p.tagName, 'SECTION', 'a section with a name is a region landmark')
  assert.equal(p.getAttribute('aria-label'), 'Cost totals')
  assert.equal(p.getAttribute('lang'), 'en')
  assert.match(p.textContent ?? '', /estimate of context cost|context cost/i)
  assert.match(p.textContent ?? '', /120k tokens in context/)
  assert.doesNotMatch(p.textContent ?? '', /at least/)
})

test('Cost panel open, events lost: the DOM totals say "(incomplete)", like the drawing (#591)', async () => {
  const r = await mount({ s1: 7 })
  assert.ok(drawn.some(t => /^[\d.]+[kM]? ctx tokens \(incomplete\)$/.test(t)), `canvas header: ${JSON.stringify(drawn)}`)
  assert.match(panel(r)?.textContent ?? '', /\(incomplete\)/)
  assert.doesNotMatch(panel(r)?.textContent ?? '', /at least/)
})

test('French: the region, its name and the qualifiers are French, lang declared', async () => {
  setLocaleChoice('fr')
  const r = await mount({ s1: 7 })
  const p = panel(r)
  assert.ok(p)
  assert.equal(p.getAttribute('lang'), 'fr')
  assert.equal(p.getAttribute('aria-label'), 'Totaux du coût')
  assert.match(p.textContent ?? '', /\(incomplet\)/)
  assert.match(p.textContent ?? '', /jetons dans le contexte/)
  assert.doesNotMatch(p.textContent ?? '', /at least|au moins|incomplete|tokens in context/)
})

test('Cost panel closed: no region, and the top bar still reads the totals (the only place without a panel)', async () => {
  const r = await mount(null, false)
  assert.equal(panel(r)?.textContent ?? null, null)
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
  const p = panel(r)
  assert.ok(p, 'the region is rendered (otherwise axe would have nothing to check)')
  const results = await axe.run(p.parentElement ?? p)
  assert.deepEqual(results.violations.map(v => v.id), [])
})

// ─── #555 review follow-up: qualifiers of the unattributed part, full screen, the drawing's emptiness rule, single session ───

/** The qualifiers of the drawing's unattributed row (`900k · ~$X estimated`, draw-cost.ts), in words */
const UNATTRIBUTED_EN = /including 900k unattributed tokens \(about \$[\d.]+ estimated\)/

test('single session: the unattributed part carries the tokens and the qualifiers of the drawing ("about", "estimated")', async () => {
  const r = await mount(null, true, { row: 1, events: [...TOOL_AND_CONTEXT, ORPHAN] })
  assert.ok(drawn.includes('Unattributed'), `precondition: the canvas draws the unattributed row: ${JSON.stringify(drawn)}`)
  const restRow = drawn.find(t => /^900k · ~\$/.test(t))
  assert.ok(restRow && / estimated$/.test(restRow), `precondition: the drawing qualifies it as an estimate: ${restRow}`)
  const text = panel(r)?.textContent ?? ''
  assert.match(text, UNATTRIBUTED_EN, text)
  assert.doesNotMatch(text, /including \$[\d.]+ unattributed/, 'never a bare, exact-looking figure')
})

test('All sessions: the unattributed part is given too, like the drawing (which shows the row in every mode); not an estimate, no "estimated"', async () => {
  const r = await mount(null, true, { events: [...TOOL_AND_CONTEXT, ORPHAN_READING] })
  const restRow = drawn.find(t => /^900k · ~\$/.test(t))
  assert.ok(restRow && !/estimated/.test(restRow), `precondition: the canvas draws the row in All, not as an estimate: ${restRow}`)
  const text = panel(r)?.textContent ?? ''
  assert.match(text, /including 900k unattributed tokens \(about \$[\d.]+\)/, text)
})

test('nothing to total: the canvas draws no panel, so the region renders nothing (no "$0.00")', async () => {
  const r = await mount(null, true, { row: 1, events: [ev('s1', 'agent_spawn', { name: 'main', isMain: true }, 0)] })
  assert.ok(!drawn.some(t => /ctx tokens/.test(t)), `precondition: no Cost panel header drawn: ${JSON.stringify(drawn)}`)
  // Compare the text, never the element: a failing assert.equal on a jsdom node inspects its whole graph and runs out of memory
  assert.equal(panel(r)?.textContent ?? null, null, 'no region while the drawing shows nothing')
})

test('full screen: the canvas still draws the Cost panel, and the region keeps its text equivalent', async () => {
  const r = await mount({ s1: 7 })
  await pressInMore(() => r.getByRole('button', { name: 'Enter full screen' }))
  drawn = []
  await wait(400)
  assert.ok(r.getByRole('button', { name: 'Exit full screen' }), 'precondition: full screen is on')
  assert.ok(drawn.some(t => /ctx tokens( \(incomplete\))?$/.test(t)), `precondition: the canvas draws the Cost panel in full screen: ${JSON.stringify(drawn)}`)
  const p = panel(r)
  assert.ok(p, 'the totals keep a DOM equivalent in full screen')
  assert.match(p.textContent ?? '', /\(incomplete\)/)
  assert.match(p.textContent ?? '', /120k tokens in context \(incomplete\)/)
})

test('French: the unattributed part reads "estimé", with a word for the "~" of the drawing ("environ")', async () => {
  setLocaleChoice('fr')
  const r = await mount(null, true, { row: 1, events: [...TOOL_AND_CONTEXT, ORPHAN] })
  const text = panel(r)?.textContent ?? ''
  assert.match(text, /dont 900k jetons non attribués \(environ \$[\d.]+ estimé\)/, text)
  assert.doesNotMatch(text, /unattributed|estimated|about/)
})

test('French: a cost the runtime does not report reads "coût non communiqué" (component, the wording path)', () => {
  setLocaleChoice('fr')
  const none = { value: null, status: 'unavailable', estimated: false } as const
  // An agent with a figure, so the region renders; cost and tokens passed as not reported: it says so, never "$0.00"
  const agent = { tokensUsed: 1000, tokenStatus: 'available' as const }
  const { container } = render(<CostTotalsText tokens={none} cost={none} agents={[agent]} unattributed={[]} />)
  const text = container.querySelector('[data-testid="cost-panel-totals"]')?.textContent ?? ''
  assert.match(text, /coût non communiqué/, text)
  assert.match(text, /jetons non communiqués/, text)
  assert.doesNotMatch(text, /\$0/)
})

// ─── #576: the bar says the unattributed part like the drawing and the region, in every view ───

test('#576 single session: the bar reads the unattributed part with the same tokens and qualifiers as the region', async () => {
  const r = await mount(null, true, { row: 1, events: [...TOOL_AND_CONTEXT, ORPHAN] })
  assert.match(spoken(r), UNATTRIBUTED_EN, spoken(r))
  assert.doesNotMatch(spoken(r), /including \$[\d.]+ unattributed/)
})

test('#576 All sessions: the bar reads it too (it used to leave it out), without "estimated" for a reading', async () => {
  const r = await mount(null, true, { events: [...TOOL_AND_CONTEXT, ORPHAN_READING] })
  assert.match(spoken(r), /including 900k unattributed tokens \(about \$[\d.]+\)/, spoken(r))
})

test('#576 French: the bar reads "environ" and "estimé" like the region', async () => {
  setLocaleChoice('fr')
  const r = await mount(null, true, { row: 1, events: [...TOOL_AND_CONTEXT, ORPHAN] })
  assert.match(spoken(r), /dont 900k jetons non attribués \(environ \$[\d.]+ estimé\)/, spoken(r))
})
