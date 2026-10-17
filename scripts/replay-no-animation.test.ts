// A replayed or imported history (app start, opening a large workflow) must not replay its animations:
// no travelling particles, no fade-in or scale-in for what it creates. A live event keeps its animation.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEventBatch, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState } from '../web/hooks/simulation/types'
import { findToolSlot } from '../web/hooks/simulation/tool-slot'
import type { SimulationEvent } from '../web/lib/agent-types'

function makeCtx(): ProcessEventContext {
  return {
    syncForceSimulation: () => {},
    findToolSlot,
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: true,
  }
}

function history(flag: 'replayed' | 'imported' | null): SimulationEvent[] {
  const extra = flag ? { [flag]: true } : {}
  return [
    { time: 0.1, sessionId: 's', type: 'agent_spawn', payload: { name: 'main', isMain: true, task: 't' }, ...extra },
    { time: 0.2, sessionId: 's', type: 'tool_call_start', payload: { agent: 'main', tool: 'Read', args: 'a.ts', inputData: { file_path: 'a.ts' } }, ...extra },
    { time: 0.3, sessionId: 's', type: 'tool_call_end', payload: { agent: 'main', tool: 'Read', result: 'ok', isError: false }, ...extra },
    { time: 0.4, sessionId: 's', type: 'tool_call_start', payload: { agent: 'main', tool: 'Edit', args: 'b.ts', inputData: { file_path: 'b.ts' } }, ...extra },
  ] as SimulationEvent[]
}

for (const flag of ['replayed', 'imported'] as const) {
  test(`${flag} events leave no particle and no entry animation`, () => {
    const { state } = processEventBatch(history(flag), createEmptyState(), makeCtx(), { advanceClock: true })
    assert.equal(state.particles.length, 0)
    for (const a of state.agents.values()) { assert.equal(a.opacity, 1); assert.equal(a.scale, 1) }
    const running = [...state.toolCalls.values()].filter(t => t.state === 'running')
    assert.ok(running.length > 0)
    for (const t of running) assert.equal(t.opacity, 1)
    for (const t of running) assert.equal(state.edges.find(e => e.to === t.id)?.opacity, 1)
    // A finished call has nothing left to show, nor does its edge
    for (const t of state.toolCalls.values()) if (t.state !== 'running') assert.equal(t.opacity, 0)
  })
}

test('live events still animate', () => {
  const { state } = processEventBatch(history(null), createEmptyState(), makeCtx(), { advanceClock: true })
  assert.ok(state.particles.length > 0)
  assert.ok([...state.agents.values()].some(a => a.opacity < 1 || a.scale < 1))
})

test('a live event after a replayed one keeps its particle', () => {
  const past = processEventBatch(history('replayed'), createEmptyState(), makeCtx(), { advanceClock: true }).state
  const live = { time: 1, sessionId: 's', type: 'tool_call_start', payload: { agent: 'main', tool: 'Grep', args: 'x', inputData: {} } } as SimulationEvent
  const { state } = processEventBatch([live], past, makeCtx(), { advanceClock: true })
  assert.equal(state.particles.length, 1)
})
