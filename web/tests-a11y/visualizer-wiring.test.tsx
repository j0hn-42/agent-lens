// AgentVisualizer (index.tsx) wiring, mounted with the REAL bridge fed by window messages: what the
// shell passes to the cards and the top bar. The cards are unit-tested with hand-made props elsewhere
// (inspector-own-state, costs-active-ui); here the values come from the product code path.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'

import { AgentVisualizer } from '@/components/agent-visualizer'
import { clearPair } from '@/lib/pair-filter-store'
import { resetDefaultUiPreferencesStore } from '@/hooks/use-ui-preferences'

const noopDeep = (): unknown => new Proxy(function () {}, { get: (_t, k) => (k === 'state' ? 'running' : k === 'currentTime' ? 0 : noopDeep()), apply: () => noopDeep(), set: () => true })
;(globalThis as Record<string, unknown>).AudioContext = function () { return noopDeep() }
;(globalThis as Record<string, unknown>).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} }

type Call = { name: string; args: unknown[] }
let calls: Call[] = []
const realGetContext = window.HTMLCanvasElement.prototype.getContext

beforeEach(() => {
  clearPair()
  calls = []
  const ctx: any = new Proxy({ canvas: { width: 800, height: 600 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return (...args: unknown[]) => { calls.push({ name: k, args }); return undefined }
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never
})
afterEach(() => {
  cleanup(); document.body.replaceChildren(); clearPair(); resetDefaultUiPreferencesStore()
  window.HTMLCanvasElement.prototype.getContext = realGetContext
})

const post = (data: unknown) => window.dispatchEvent(new window.MessageEvent('message', { data }))
const ev = (sessionId: string, type: string, payload: Record<string, unknown>, time = 1) =>
  ({ type: 'agent-event', event: { time, type, sessionId, payload } })
const info = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id, label, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: `/w/${label}`, runtime: 'claude', ...extra,
})
const wait = (ms = 300) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

const outlineButton = (c: HTMLElement, text: RegExp) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>('button[data-graph-node]')).find(b => text.test(b.textContent ?? ''))

/** The Sessions panel: open it (once) and work on its rows. */
async function openSessions(r: ReturnType<typeof render>) {
  if (!r.container.querySelector('[data-row-main]')) {
    await act(async () => { fireEvent.click(r.getByRole('button', { name: /^Sessions:/ })) })
    await wait(100)
  }
}
const sessionRows = (r: ReturnType<typeof render>) => Array.from(r.container.querySelectorAll<HTMLElement>('[data-row-main]'))

/** `row` 0 = the 'All sessions' row; null keeps the session the bridge selects by itself */
async function mountWith(sessions: unknown[], events: unknown[], row: number | null = 0) {
  const r = render(<AgentVisualizer />)
  await act(async () => {
    post({ type: '__vscode-bridge-init' })
    post({ type: 'session-list', sessions })
  })
  await wait(100)
  if (row !== null) {
    await openSessions(r)
    await act(async () => { fireEvent.click(sessionRows(r)[row]) })
  }
  await wait(100)
  await act(async () => { for (const e of events) post(e) })
  await act(async () => { fireEvent.click(r.getByRole('button', { name: /Hide inactive agents/ })) }) // idle agents are hidden by default
  await wait(700)
  return r
}

const SA = info('sa', 'payments-api')
const baseEvents = [
  ev('sa', 'agent_spawn', { name: 'main-a', isMain: true }),
  ev('sa', 'agent_spawn', { name: 'worker-a', parent: 'main-a' }),
]
const dialogText = (r: ReturnType<typeof render>) => Array.from(r.container.querySelectorAll('[role=dialog]')).map(d => d.textContent ?? '').join('\n')

test('the inspector turns into the "gone" card, naming the node, when its agent leaves the graph', async () => {
  const r = await mountWith([SA, info('sb', 'web-app', { lastActivityTime: Date.now() - 5000 })], [
    ...baseEvents, ev('sb', 'agent_spawn', { name: 'main-b', isMain: true }),
  ], null)
  assert.ok(outlineButton(r.container, /^worker-a/), 'precondition: the session of worker-a is the one shown')
  await act(async () => { fireEvent.click(outlineButton(r.container, /^worker-a/)!) })
  await wait(200)
  assert.match(dialogText(r), /worker-a/)
  assert.equal(r.container.querySelector('[data-testid="inspector-gone"]'), null, 'a live agent has its detail card')

  // Another session is shown: the agents of this one are no longer in the graph, the selection is kept
  await openSessions(r)
  const other = sessionRows(r).find(el => /web-app/.test(el.textContent ?? '') && !el.getAttribute('aria-label'))!
  await act(async () => { fireEvent.click(other) })
  await wait(700)
  const gone = r.container.querySelector('[data-testid="inspector-gone"]')
  assert.ok(gone, `the shell passes the missing selection to AgentGoneCard (${dialogText(r)})`)
  assert.match(gone!.textContent ?? '', /worker-a/, 'it names the node it remembered')
})

test('the detail card gets the error count of the selected agent only (per node, not per session)', async () => {
  const r = await mountWith([SA], [
    ...baseEvents,
    ev('sa', 'tool_call_start', { agent: 'worker-a', tool: 'Bash', toolUseId: 't1', args: 'make' }, 2),
    ev('sa', 'tool_call_end', { agent: 'worker-a', tool: 'Bash', toolUseId: 't1', result: 'boom', isError: true, errorMessage: 'boom' }, 3),
  ], null)
  await act(async () => { fireEvent.click(outlineButton(r.container, /^worker-a/)!) })
  await wait(200)
  assert.match(dialogText(r), /1 tool error/, dialogText(r))
  await act(async () => { fireEvent.click(outlineButton(r.container, /^main-a/)!) })
  await wait(200)
  assert.match(dialogText(r), /0 tool errors/, 'the orchestrator did not fail')
})

test('the top bar totals include an usage that belongs to no agent, flagged as unattributed', async () => {
  const withOrphan = await mountWith([SA], [...baseEvents, ev('sa', 'context_update', { agent: 'ghost', tokens: 900_000 })], null)
  const text = withOrphan.container.textContent ?? ''
  assert.match(text, /900k tokens/, 'the orphan tokens are in the session total')
  assert.match(text, /unattributed/)
  cleanup()

  const clean = await mountWith([SA], baseEvents, null)
  assert.ok(!/unattributed/.test(clean.container.textContent ?? ''), 'nothing unattributed, nothing claimed')
})

test('proven session links reach the canvas: a child session drawn with the dotted link to its parent', async () => {
  const dots = () => calls.filter(c => c.name === 'setLineDash' && Array.isArray(c.args[0]) && (c.args[0] as number[]).length === 2
    && Math.round(((c.args[0] as number[])[0] / (c.args[0] as number[])[1]) * 10) / 10 === 0.4).length
  const spawns = [
    ev('sa', 'agent_spawn', { name: 'main-a', isMain: true }),
    ev('sb', 'agent_spawn', { name: 'main-b', isMain: true }),
  ]
  await mountWith([SA, info('sb', 'child-run')], spawns)
  const baseline = dots()
  cleanup()
  calls.length = 0

  await mountWith([SA, info('sb', 'child-run', { parentSessionId: 'sa' })], spawns)
  assert.ok(dots() > baseline, `a Task link is drawn between the two session halos (${dots()} vs ${baseline})`)
})
