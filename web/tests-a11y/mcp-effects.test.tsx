import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../hooks/simulation/types'
import { detectStateChanges } from '../components/agent-visualizer/canvas/detect-state-changes'
import { COLORS } from '../lib/colors'
import type { SimulationEvent } from '../lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'> & { time: number }>): SimulationState {
  let state = createEmptyState()
  for (const e of events) {
    state = processEvent({ time: e.time, type: e.type, payload: e.payload }, { ...state, currentTime: e.time }, ctx)
  }
  return state
}

const spawn = { time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true } } as const

test('completing an MCP tool spawns a cyan shatter and a sonar pulse; native tools get no pulse', () => {
  const mcpStart = run([spawn, { time: 1, type: 'tool_call_start', payload: { agent: 'main', tool: 'mcp__stripe__refund' } }])
  const prevTools = new Map([...mcpStart.toolCalls].map(([id, t]) => [id, t.state as string]))
  const done = run([spawn,
    { time: 1, type: 'tool_call_start', payload: { agent: 'main', tool: 'mcp__stripe__refund' } },
    { time: 2, type: 'tool_call_end', payload: { agent: 'main', tool: 'mcp__stripe__refund', result: 'ok' } }])
  // ids embed the start time, so the id is stable between the two runs
  const out = detectStateChanges(done.agents, done.toolCalls, new Map(), prevTools)
  assert.ok(out.effects.some(e => e.type === 'mcp' && e.color === COLORS.mcp))
  assert.ok(out.effects.some(e => e.type === 'shatter' && e.color === COLORS.mcp))

  const nativeStart = run([spawn, { time: 1, type: 'tool_call_start', payload: { agent: 'main', tool: 'Read' } }])
  const nativePrev = new Map([...nativeStart.toolCalls].map(([id, t]) => [id, t.state as string]))
  const nativeDone = run([spawn,
    { time: 1, type: 'tool_call_start', payload: { agent: 'main', tool: 'Read' } },
    { time: 2, type: 'tool_call_end', payload: { agent: 'main', tool: 'Read', result: 'ok' } }])
  const nativeOut = detectStateChanges(nativeDone.agents, nativeDone.toolCalls, new Map(), nativePrev)
  assert.ok(!nativeOut.effects.some(e => e.type === 'mcp'))
})

