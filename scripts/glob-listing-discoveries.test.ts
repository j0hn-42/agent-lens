// #451: a Glob's file cards come from the structured listing the extension forwards (the real text output has no
// "Found N files" header). Read only when present and valid; no card is ever made from anything else.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { searchDiscoveries } from '../web/lib/search-discoveries'
import { SEARCH_DISCOVERY } from '../web/lib/canvas-constants'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame } from '../web/hooks/simulation/animate'
import type { SimulationEvent, ToolCallNode } from '../web/lib/agent-types'
import { searchFlowSegments } from '../web/components/agent-visualizer/canvas/search-flow'

// What a real Glob prints: a bare list, no header
const GLOB_TEXT = 'src/deploy-commands.ts\ndist/deploy-commands.js'
const LISTING = { files: ['src/deploy-commands.ts', 'dist/deploy-commands.js'], count: 2 }
const call = { agentId: 's1:a', toolName: 'Glob', inputData: { pattern: '**/deploy-commands.*' }, toolUseId: 'tu1', x: 100, y: 50 }

/** The paths of the cards a Glob listing gives; null when none (a listing that is not valid) */
const readSearchListing = (v: unknown) => {
  const ds = searchDiscoveries(call, 'src/a.ts', 3, v)
  return ds.length === 0 ? null : ds.map(d => d.content)
}

test('a valid listing is read, anything else gives no card', () => {
  assert.deepEqual(readSearchListing(LISTING), LISTING.files)
  for (const v of [undefined, null, 'x', 3, [], {}, { files: [], count: 0 }, { files: ['a'] }, { count: 1 },
    { files: ['a'], count: 0 }, { files: ['a', 'b'], count: 1 }, { files: ['a'], count: 1.5 }, { files: ['a'], count: -1 },
    { files: ['a', 1], count: 2 }, { files: ['a', 'a'], count: 2 }, { files: [''], count: 1 }, { files: ['a\nb'], count: 1 },
    { files: ['x'.repeat(301)], count: 1 }, { files: Array.from({ length: 21 }, (_, i) => `f${i}`), count: 21 },
    { files: ['a'], count: 2_000_000_000 }]) {
    assert.equal(readSearchListing(v), null, JSON.stringify(v)?.slice(0, 60))
  }
})

test('a Glob with a structured listing: one file card per file, the count is the tool\'s', () => {
  const ds = searchDiscoveries(call, GLOB_TEXT, 3, LISTING)
  assert.deepEqual(ds.map(d => d.content), LISTING.files)
  assert.deepEqual(ds.map(d => d.id), ['disc-s1:a-tu1-0', 'disc-s1:a-tu1-1'])
  assert.deepEqual(ds.map(d => d.listing), [
    { tool: 'Glob', position: 1, reported: 2, shown: 2 },
    { tool: 'Glob', position: 2, reported: 2, shown: 2 },
  ])
  assert.ok(ds.every(d => d.toolUseId === 'tu1'))
})

test('a Glob listing larger than the cap: at most maxPerCall cards, the whole count reported', () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`)
  const ds = searchDiscoveries(call, 'src/f0.ts', 3, { files, count: 340 })
  assert.equal(ds.length, SEARCH_DISCOVERY.maxPerCall)
  assert.ok(ds.every(d => d.listing!.reported === 340 && d.listing!.shown === SEARCH_DISCOVERY.maxPerCall))
})

test('no valid listing, no card: a bare Glob text alone proves nothing', () => {
  assert.deepEqual(searchDiscoveries(call, GLOB_TEXT, 3), [])
  assert.deepEqual(searchDiscoveries(call, GLOB_TEXT, 3, undefined), [])
  assert.deepEqual(searchDiscoveries({ ...call, toolUseId: undefined }, GLOB_TEXT, 3, LISTING), [])
})

test('a listing only counts for Glob', () => {
  assert.deepEqual(searchDiscoveries({ ...call, toolName: 'Read' }, 'x', 3, LISTING), [])
  assert.deepEqual(searchDiscoveries({ ...call, toolName: 'Bash' }, 'x', 3, LISTING), [])
})

// Through the real event path, then the draw loop's flow
const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 40, y: 20 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { time: number }
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
const start: Ev = { time: 1, type: 'tool_call_start', payload: { agent: 'a', tool: 'Glob', args: '**/deploy-commands.*', toolUseId: 'g1', inputData: { pattern: '**/deploy-commands.*' } } }
const endWith = (extra: Record<string, unknown>): Ev => ({ time: 2, type: 'tool_call_end', payload: { agent: 'a', tool: 'Glob', result: GLOB_TEXT, toolUseId: 'g1', ...extra } })

test('a Glob through processEvent: cards from the listing, and the flow draws one segment per card (#384)', () => {
  const s = run([spawn, start, endWith({ listing: LISTING })])
  assert.equal(s.discoveries.length, 2)
  const callNode = Array.from(s.toolCalls.values()).find((t): t is ToolCallNode => t.toolName === 'Glob')!
  const segs = searchFlowSegments(s.discoveries, s.toolCalls, size, s.currentTime)
  assert.equal(segs.length, 2, 'the segment is keyed on the toolUseId, whatever the tool')
  assert.ok(segs.every(g => g.toolCallId === callNode.id))
})

test('a Glob through processEvent: no listing, an invalid one, or a failed call makes no card', () => {
  assert.equal(run([spawn, start, endWith({})]).discoveries.length, 0)
  assert.equal(run([spawn, start, endWith({ listing: { files: ['a', 'b'], count: 1 } })]).discoveries.length, 0)
  assert.equal(run([spawn, start, endWith({ listing: 'src/a.ts' })]).discoveries.length, 0)
  assert.equal(run([spawn, start, endWith({ listing: LISTING, isError: true, errorMessage: 'boom' })]).discoveries.length, 0)
})

test('a replayed Glob result adds no second set of cards', () => {
  const s = run([spawn, start, endWith({ listing: LISTING }), endWith({ listing: LISTING })])
  assert.equal(s.discoveries.length, 2)
})
