// Timeline table view follows the simulation (#214): a new tool call adds a row without a new agent.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { TimelinePanel } from '@/components/agent-visualizer/timeline-panel'
import { processEvent, type ProcessEventContext } from '@/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '@/hooks/simulation/types'
import type { SimulationEvent } from '@/lib/agent-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function step(prev: SimulationState, time: number, type: SimulationEvent['type'], payload: Record<string, unknown>): SimulationState {
  return processEvent({ time, type, payload, sessionId: 's1' }, { ...prev, currentTime: time }, ctx)
}

function bodyRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.tBodies[0].rows)
}

test('with the table view open, a new tool call adds a row and keeps the number of agents', async () => {
  let state = createEmptyState()
  state = step(state, 1, 'agent_spawn', { name: 'orchestrator', isMain: true })
  state = step(state, 2, 'agent_spawn', { name: 'explore', parent: 'orchestrator' })

  const view = render(<TimelinePanel visible timelineEntries={state.timelineEntries} currentTime={2} onClose={() => {}} />)
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Table view' })) })
  const table = view.getByRole('table') as HTMLTableElement
  const before = bodyRows(table)
  const agentsBefore = new Set(before.map(r => r.querySelector('th')!.textContent))
  assert.equal(agentsBefore.size, 2)
  assert.equal(before.length, 2)

  const next = step(state, 3, 'tool_call_start', { agent: 'orchestrator', tool: 'Read', args: 'a.ts' })
  assert.equal(next.timelineEntries.size, state.timelineEntries.size, 'no agent appeared')
  view.rerender(<TimelinePanel visible timelineEntries={next.timelineEntries} currentTime={3} onClose={() => {}} />)

  const after = bodyRows(table)
  assert.equal(after.length, before.length + 1, 'the new tool call has its own row')
  assert.equal(new Set(after.map(r => r.querySelector('th')!.textContent)).size, agentsBefore.size)
  assert.ok(after.some(r => r.textContent?.includes('Read: a.ts')), 'the row names the tool call')
  const starting = after.find(r => r.querySelector('th')!.textContent === 'orchestrator' && r.textContent?.includes('Starting'))!
  assert.ok(!starting.textContent?.includes('ongoing'), 'the block closed by the tool call is no longer ongoing')
})
