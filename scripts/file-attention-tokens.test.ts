import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
type Ev = Pick<SimulationEvent, 'type' | 'payload'>
function run(events: Ev[]): SimulationState {
  let state = createEmptyState()
  let t = 0
  for (const e of events) {
    t++
    state = processEvent({ time: t, type: e.type, payload: e.payload }, { ...state, currentTime: t }, ctx)
  }
  return state
}
const spawn: Ev = { type: 'agent_spawn', payload: { name: 'main', isMain: true } }
const start = (file: string, id: string): Ev =>
  ({ type: 'tool_call_start', payload: { agent: 'main', tool: 'Read', args: file, inputData: { file_path: file }, toolUseId: id } })
const end = (id: string, tokenCost: number, tokenSource?: string): Ev =>
  ({ type: 'tool_call_end', payload: { agent: 'main', tool: 'Read', result: 'ok', toolUseId: id, tokenCost, ...(tokenSource ? { tokenSource } : {}) } })

test('read tokens go to the file of the matched call, not the first file read by the agent', () => {
  const s = run([spawn, start('/r/a.ts', 'u1'), end('u1', 100), start('/r/b.ts', 'u2'), end('u2', 300)])
  assert.equal(s.fileAttention.get('/r/a.ts')?.totalTokens, 100)
  assert.equal(s.fileAttention.get('/r/b.ts')?.totalTokens, 300)
})

test('a file whose tokens are estimated is flagged', () => {
  const s = run([spawn, start('/r/a.ts', 'u1'), end('u1', 100, 'estimated'), start('/r/b.ts', 'u2'), end('u2', 50, 'reported')])
  assert.equal(s.fileAttention.get('/r/a.ts')?.tokensEstimated, true)
  assert.notEqual(s.fileAttention.get('/r/b.ts')?.tokensEstimated, true)
})
