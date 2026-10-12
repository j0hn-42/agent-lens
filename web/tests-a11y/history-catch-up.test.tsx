// #210: a burst of received events is caught up over several frames in the REAL useAgentSimulation hook, and
// the page shows, then announces, how far the history has loaded.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { renderHook, render, act, cleanup } from '@testing-library/react'
import axe from 'axe-core'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { HistoryLoadingIndicator } from '@/components/agent-visualizer/history-loading-indicator'
import { historyLoadingText, historyLoadedText } from '@/lib/history-loading'
import { observedSessions } from '@/lib/session-model'
import type { SimulationEvent } from '@/lib/agent-types'

const T0 = 1_700_000_000_000
const FRAME_MS = 20

const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 })
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => { act(() => { cb(Date.now()) }) }, FRAME_MS) as unknown as number
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
  observedSessions.clear()
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  mock.timers.reset()
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  observedSessions.clear()
})

let consumed = 0
// Like the bridge: one pending array, emptied in place when the simulation consumes it
const pending: SimulationEvent[] = []

function mount(budgetMs: number) {
  pending.length = 0
  const view = renderHook(
    () => useAgentSimulation({
      useMockData: false, externalEvents: pending, sessionFilter: null,
      onExternalEventsConsumed: () => { consumed++; pending.length = 0 },
      catchUpFrameBudgetMs: budgetMs,
    }),
  )
  act(() => { view.result.current.play() })
  return view
}
const frame = () => act(() => { mock.timers.tick(FRAME_MS) })
function send(events: SimulationEvent[]) {
  consumed = 0
  pending.push(...events)
  for (let i = 0; i < 5 && consumed === 0; i++) frame()
  assert.equal(consumed, 1, 'consumed by one frame')
}

function burst(agents: number): SimulationEvent[] {
  const events: SimulationEvent[] = []
  for (let i = 0; i < agents; i++) {
    events.push({ sessionId: 's1', time: i * 0.1, type: 'agent_spawn', payload: { name: `a${i}`, isMain: true, task: 't' } })
    events.push({ sessionId: 's1', time: i * 0.1 + 0.05, type: 'tool_call_start', payload: { agent: `a${i}`, tool: 'Read', args: 'x.ts' } })
  }
  return events
}

test('a burst is caught up over several frames and reports its progress (n/N)', () => {
  const view = mount(0)  // a zero budget: one event per frame
  const events = burst(20)
  send(events)
  const receivedAt = Date.now()
  const first = view.result.current.catchUp
  assert.ok(first, 'a backlog is reported')
  assert.equal(first.total, 40)
  assert.ok(first.done >= 1 && first.done < 40, `partly done (${first.done})`)
  assert.ok(view.result.current.frameRef.current.agents.size < 20, 'the burst did not run in one frame')

  let guard = 0
  while (view.result.current.catchUp && guard++ < 200) frame()
  assert.equal(view.result.current.catchUp, null, 'the backlog drains')
  const s = view.result.current.frameRef.current
  assert.equal(s.agents.size, 20)
  assert.equal(s.eventLog.length, 40, 'every event reached the log, once')
  assert.deepEqual(s.eventLog.map(e => e.time), events.map(e => e.time))
  for (const a of s.agents.values()) assert.equal(a.lastEventAt, receivedAt, 'heard from at reception time, not at the later frame that processed it')
})

test('a small batch is processed in its frame without any loading state', () => {
  const view = mount(8)
  send(burst(2))
  frame()
  assert.equal(view.result.current.frameRef.current.agents.size, 2)
  assert.equal(view.result.current.catchUp, null)
})

test('restart drops the backlog of the previous view', () => {
  const view = mount(0)
  send(burst(10))
  assert.ok(view.result.current.catchUp)
  act(() => { view.result.current.restart() })
  frame(); frame()
  assert.equal(view.result.current.catchUp, null)
  assert.equal(view.result.current.frameRef.current.agents.size, 0)
})

test('a saved snapshot keeps its backlog, restoring it resumes the catch-up', () => {
  const view = mount(0)
  send(burst(10))
  const snapshot = view.result.current.saveSnapshot()
  act(() => { view.result.current.restart() })
  frame()
  act(() => { view.result.current.restoreSnapshot(snapshot) })
  let guard = 0
  while (view.result.current.catchUp && guard++ < 100) frame()
  assert.equal(view.result.current.frameRef.current.agents.size, 10)
  assert.equal(view.result.current.frameRef.current.eventLog.length, 20)
})

async function axeViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false }, 'landmark-one-main': { enabled: false }, 'page-has-heading-one': { enabled: false } },
  })
  return results.violations.map(v => v.id)
}

test('texts carry the real counts', () => {
  mock.timers.reset()
  assert.equal(historyLoadingText({ done: 1200, total: 50000 }), 'Loading history (1200/50000)')
  assert.equal(historyLoadedText(50000), 'History loaded (50000 events)')
  assert.equal(historyLoadedText(1), 'History loaded (1 event)')
})

test('the indicator is shown while loading, then announced politely and gone once done', async () => {
  mock.timers.reset()  // axe schedules real timers
  const { container, rerender, queryByTestId, getByRole } = render(<HistoryLoadingIndicator progress={null} />)
  const live = () => container.querySelector('[aria-live="polite"]')!
  assert.equal(queryByTestId('history-loading'), null, 'nothing shown without a backlog')
  assert.equal(live().textContent, '', 'nothing announced on mount')

  rerender(<HistoryLoadingIndicator progress={{ done: 0, total: 300 }} />)
  assert.equal(queryByTestId('history-loading')!.textContent, 'Loading history (0/300)')
  assert.equal(live().textContent, 'Loading history (0/300)', 'the start is announced')
  const bar = getByRole('progressbar', { name: 'Loading history' })
  assert.equal(bar.getAttribute('aria-valuenow'), '0')
  assert.equal(bar.getAttribute('aria-valuemax'), '300')
  assert.deepEqual(await axeViolations(container), [])

  rerender(<HistoryLoadingIndicator progress={{ done: 150, total: 300 }} />)
  assert.equal(queryByTestId('history-loading')!.textContent, 'Loading history (150/300)')
  assert.equal(getByRole('progressbar').getAttribute('aria-valuenow'), '150')
  assert.equal(live().textContent, 'Loading history (0/300)', 'progress steps are not announced one by one')

  rerender(<HistoryLoadingIndicator progress={null} />)
  assert.equal(queryByTestId('history-loading'), null)
  assert.equal(live().textContent, 'History loaded (300 events)', 'the end is announced with the real count')
  assert.deepEqual(await axeViolations(container), [])
})
