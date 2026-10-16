// #384: the search flow from the real event path to the draw loop. search-flow.test.ts feeds hand-written
// discoveries and calls; here a Grep goes through processEvent, and the draw loop is checked to draw the flow in
// the links layer and to gate the frame rate on the scene it draws.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame } from '../web/hooks/simulation/animate'
import { SEARCH_FLOW } from '../web/lib/canvas-constants'
import type { SimulationEvent } from '../web/lib/agent-types'
import { searchFlowSegments, searchFlowMoves } from '../web/components/agent-visualizer/canvas/search-flow'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 40, y: 20 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { time: number }
/** The events, then half a second of animation frames so the cards and the tool card have faded in */
function run(events: Ev[]): SimulationState {
  let state = createEmptyState()
  for (const e of events) state = processEvent({ time: e.time, type: e.type, payload: e.payload, sessionId: 's1' }, { ...state, currentTime: e.time }, ctx)
  for (let i = 0; i < 5; i++) {
    const next = state.currentTime + 0.1
    state = computeNextFrame(state, 0.1, next, 1000, state, { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 })
  }
  return state
}
const size = () => ({ w: 100, h: 20 })
const spawn: Ev = { time: 0, type: 'agent_spawn', payload: { name: 'a', isMain: true } }
const GREP = 'Found 3 files\na.ts\nb.ts\nc.ts'

test('a Grep through processEvent: one segment per file card, all from its call, moving only in the window (#384)', () => {
  const s = run([
    spawn,
    { time: 1, type: 'tool_call_start', payload: { agent: 'a', tool: 'Grep', args: 'foo', toolUseId: 'tu1', inputData: { pattern: 'foo' } } },
    { time: 2, type: 'tool_call_end', payload: { agent: 'a', tool: 'Grep', result: GREP, toolUseId: 'tu1' } },
  ])
  const callId = Array.from(s.toolCalls.values()).find(t => t.toolName === 'Grep')!.id
  const segs = searchFlowSegments(s.discoveries, s.toolCalls, size, s.currentTime)
  assert.equal(segs.length, 3)
  assert.ok(segs.every(g => g.toolCallId === callId))
  assert.ok(s.currentTime > 2 && s.currentTime < 2 + SEARCH_FLOW.chipWindowS)
  assert.ok(segs.every(g => g.moving))
  assert.equal(searchFlowMoves(s.discoveries, s.toolCalls, size, 2 + SEARCH_FLOW.chipWindowS), false)
})

// A conservative, locked choice (#384 review S-F5): the tool_use_id that only arrives with the result is given to
// the file cards (#438) but not stored on the call, so no call matches them and no line is drawn: a false negative,
// never a guessed link.
test('a Grep whose tool_use_id arrives only with its result: cards, but no line (#384)', () => {
  const s = run([
    spawn,
    { time: 1, type: 'tool_call_start', payload: { agent: 'a', tool: 'Grep', args: 'foo', inputData: { pattern: 'foo' } } },
    { time: 2, type: 'tool_call_end', payload: { agent: 'a', tool: 'Grep', result: GREP, toolUseId: 'tu-late' } },
  ])
  assert.equal(s.discoveries.length, 3, 'the cards exist')
  assert.equal(searchFlowSegments(s.discoveries, s.toolCalls, size, s.currentTime).length, 0)
})

const loop = readFileSync(join(__dirname, '..', 'web/hooks/use-canvas-draw-loop.ts'), 'utf8')

test('the draw loop draws the flow in the links layer, before the agents layer (#384)', () => {
  const links = loop.indexOf("calmOf('links')")
  const flow = loop.indexOf('drawSearchFlow(')
  const agents = loop.indexOf("opts.reducedMotion = calmOf('agents')")
  assert.ok(links > 0 && flow > 0 && agents > 0)
  assert.ok(links < flow && flow < agents, "drawSearchFlow( sits between calmOf('links') and calmOf('agents')")
})

test('the frame-rate gate: flowMoves needs the links layer awake and the drawn (filtered) scene (#384)', () => {
  const m = /const flowMoves = ([\s\S]*?)\n\s*const animating = flowMoves \|\|/.exec(loop)
  assert.ok(m, 'flowMoves is computed right before animating and feeds it')
  const expr = m[1]
  assert.match(expr, /layerIsCalm\([^)]*'links'\)/)
  assert.match(expr, /searchFlowMoves\(/)
  // The raw simulation also holds the cards of hidden agents (Hide inactive, closed branch): they draw nothing
  assert.match(expr, /p\.discoveries/, 'the gate reads the scene the frame draws')
  assert.match(expr, /p\.toolCalls/)
  assert.doesNotMatch(expr, /s\.discoveries|s\.toolCalls/)
})
