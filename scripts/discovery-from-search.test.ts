import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame } from '../web/hooks/simulation/animate'
import { DISCOVERY_HOLD_S, SEARCH_DISCOVERY } from '../web/lib/canvas-constants'
import { RESULT_CAPTURE_LIMIT } from '../web/lib/action-summary'
import type { SimulationEvent } from '../web/lib/agent-types'

// #438: the canvas discoveries are fed by the Glob / Grep calls that succeed and list their files

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 40, y: 20 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { time?: number }

function run(events: Ev[], from: SimulationState = createEmptyState()): SimulationState {
  let state = from
  for (const e of events) {
    const time = e.time ?? 1
    state = processEvent({ time, type: e.type, payload: e.payload, sessionId: 's1' }, { ...state, currentTime: time }, ctx)
  }
  return state
}

const spawn: Ev = { type: 'agent_spawn', payload: { name: 'a', isMain: true } }

function search(tool: string, result: string, end: Record<string, unknown> = {}, inputData: Record<string, unknown> = { pattern: '*.ts' }, id = 'tu1'): Ev[] {
  return [
    { time: 1, type: 'tool_call_start', payload: { agent: 'a', tool, args: 'x', toolUseId: id, inputData } },
    { time: 2, type: 'tool_call_end', payload: { agent: 'a', tool, result, toolUseId: id, ...end } },
  ]
}

// Copied from a real transcript: Grep prints paths relative to the working directory
const GREP_3 = 'Found 3 files\nsrc/services/matches.ts\nsrc/services/seasons.ts\nsrc/routes/matches.ts'

test('a completed Grep creates one file card per listed path, linked to its call', () => {
  const s = run([spawn, ...search('Grep', GREP_3, {}, { pattern: 'x' })])
  assert.deepEqual(s.discoveries.map(d => d.content), ['src/services/matches.ts', 'src/services/seasons.ts', 'src/routes/matches.ts'])
  assert.ok(s.discoveries.every(d => d.toolUseId === 'tu1' && d.agentId === agentKeyOf('s1', 'a') && d.type === 'file' && d.timestamp === 2))
  assert.deepEqual(s.discoveries.map(d => [d.x, d.y]), s.discoveries.map(d => [d.targetX, d.targetY]), 'they are born in place, no slide')
  assert.ok(s.discoveries.every(d => d.targetX === 40 + SEARCH_DISCOVERY.offsetX))
  // The pill keeps reading the header
  assert.deepEqual(Array.from(s.toolCalls.values())[0].resultPill, { kind: 'count', files: 3 })
})

test('an output cut at the capture limit gives cards only for its whole lines, with the reported count', () => {
  const long = 'src/' + 'x'.repeat(60)
  const result = `Found 47 files\n${long}1.ts\n${long}2.ts\n${long}3.ts`.slice(0, RESULT_CAPTURE_LIMIT)
  const s = run([spawn, ...search('Grep', result, {}, { pattern: 'x' })])
  assert.deepEqual(s.discoveries.map(d => d.content), [`${long}1.ts`, `${long}2.ts`])
  assert.ok(s.discoveries.every(d => d.listing?.reported === 47))
})

test('a failed or cancelled call creates no card, even with a file list in its output', () => {
  const listing = 'Found 2 files\nsrc/a.ts\nsrc/b.ts'
  assert.deepEqual(run([spawn, ...search('Grep', listing, { isError: true })]).discoveries, [])
  assert.deepEqual(run([spawn, ...search('Grep', listing, { outcome: 'cancelled' })]).discoveries, [])
})

test('a call that lists no path creates no card', () => {
  assert.deepEqual(run([spawn, ...search('Glob', 'No files found')]).discoveries, [])
  assert.deepEqual(run([spawn, ...search('Glob', 'src/a.ts\nsrc/b.ts')]).discoveries, [], 'a real Glob output has no header: not proven')
  assert.deepEqual(run([spawn, ...search('Glob', 'Found 0 files')]).discoveries, [])
})

test('Grep in content mode creates no card; in files_with_matches mode it does', () => {
  const listing = 'Found 2 files\nsrc/a.ts\nsrc/b.ts'
  assert.deepEqual(run([spawn, ...search('Grep', listing, {}, { pattern: 'x', output_mode: 'content' })]).discoveries, [])
  assert.deepEqual(run([spawn, ...search('Grep', 'src/a.ts:3:const x = 1\nsrc/b.ts:9:x()', {}, { pattern: 'x', output_mode: 'content' })]).discoveries, [])
  assert.equal(run([spawn, ...search('Grep', listing, {}, { pattern: 'x', output_mode: 'files_with_matches' })]).discoveries.length, 2)
})

test('the same tool_result replayed creates no second card', () => {
  const evs = search('Grep', 'Found 2 files\nsrc/a.ts\nsrc/b.ts')
  const once = run([spawn, ...evs])
  assert.equal(once.discoveries.length, 2, 'the first result made the cards')
  const twice = run([evs[1], { ...evs[1], time: 3 }], once)
  assert.deepEqual(twice.discoveries.map(d => d.id), once.discoveries.map(d => d.id))
  // A fresh replay of the whole history rebuilds the same ids
  assert.deepEqual(run([spawn, ...evs]).discoveries.map(d => d.id), once.discoveries.map(d => d.id))
})

test('a replayed tool_result arriving once the cards faded does not bring them back', () => {
  const evs = search('Grep', 'Found 1 file\nbackend/src/routes/auth.helpers.ts')
  let s = run([spawn, ...evs])
  assert.equal(s.discoveries.length, 1, 'the first result made the card')
  // Let the cards hold then fade out through the animation loop (the existing purge)
  let t = 2
  while (s.discoveries.length > 0 && t < 2 + DISCOVERY_HOLD_S + 60) {
    const next = t + 0.1
    s = computeNextFrame(s, 0.1, next, 1000, s, { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 })
    t = next
  }
  assert.equal(s.discoveries.length, 0, 'the cards fade out and are purged')
  s = run([{ ...evs[1], time: t + 1 }], s)
  assert.equal(s.discoveries.length, 0)
})

test('a replayed tool_result for a call already complete creates no card, even once its cards are gone', () => {
  const evs = search('Grep', 'Found 2 files\nsrc/a.ts\nsrc/b.ts')
  const done = run([spawn, ...evs])
  assert.equal(done.discoveries.length, 2)
  assert.equal(Array.from(done.toolCalls.values())[0].state, 'complete')
  // The call stays complete; only its cards are gone: a replay must not reopen the call to rebuild them
  const replayed = run([{ ...evs[1], time: 3 }], { ...done, discoveries: [] })
  assert.equal(replayed.discoveries.length, 0)
})

test('a card already on screen with the same id is not added twice', () => {
  const evs = search('Grep', 'Found 1 file\nsrc/a.ts')
  const started = run([spawn, evs[0]])
  const existing = run([spawn, ...evs]).discoveries[0]
  assert.ok(existing)
  // The call is still running and its card is already there (a result seen through another path)
  const ended = run([evs[1]], { ...started, discoveries: [existing] })
  assert.deepEqual(ended.discoveries.map(d => d.id), [existing.id])
})
