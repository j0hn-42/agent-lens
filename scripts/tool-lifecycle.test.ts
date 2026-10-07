import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame, type AnimateOptions } from '../web/hooks/simulation/animate'
import { snapVisualState } from '../web/hooks/simulation/snap-visual-state'
import { TOOL_EXPIRY_S, TOOL_MIN_DISPLAY_S } from '../web/lib/canvas-constants'
import { readToolOutcome, toolEndWarning, TOOL_STATE_LABELS, EXPIRED_WARNING } from '../web/lib/tool-lifecycle'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
const frameOptions: AnimateOptions = { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 }

function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'> & { time?: number }>): SimulationState {
  let state = createEmptyState()
  for (const e of events) {
    const time = e.time ?? 1
    state = processEvent({ time, type: e.type, payload: e.payload }, { ...state, currentTime: time }, ctx)
  }
  return state
}

/** Advances the animation clock to `to` seconds in 1 s frames. */
function advance(s: SimulationState, to: number, options: AnimateOptions = frameOptions): SimulationState {
  while (s.currentTime < to) {
    const next = Math.min(to, s.currentTime + 1)
    s = computeNextFrame(s, next - s.currentTime, next, 1e6, s, options)
  }
  return s
}

const orch = { type: 'agent_spawn' as const, payload: { name: 'orchestrator', isMain: true }, time: 0 }
const start = (toolUseId = 'toolu_1', time = 1) => ({ type: 'tool_call_start' as const, time, payload: { agent: 'orchestrator', tool: 'Bash', args: 'sleep', toolUseId } })
const only = (s: SimulationState) => Array.from(s.toolCalls.values())[0]

test('the four outcomes: completed, failed, cancelled, and expired are distinct states', () => {
  const done = run([orch, start(), { type: 'tool_call_end', time: 2, payload: { agent: 'orchestrator', tool: 'Bash', toolUseId: 'toolu_1', result: 'ok' } }])
  assert.equal(only(done).state, 'complete')
  assert.equal(only(done).endObserved, true)

  const failed = run([orch, start(), { type: 'tool_call_end', time: 2, payload: { agent: 'orchestrator', tool: 'Bash', toolUseId: 'toolu_1', result: 'boom', isError: true } }])
  assert.equal(only(failed).state, 'error')

  const cancelled = run([orch, start(), { type: 'tool_call_end', time: 2, payload: { agent: 'orchestrator', tool: 'Bash', toolUseId: 'toolu_1', result: '[interrupted]', isError: true, outcome: 'cancelled' } }])
  assert.equal(only(cancelled).state, 'cancelled')
  assert.equal(only(cancelled).endObserved, true, 'the cancellation itself was observed')

  const expired = advance(run([orch, start()]), 1 + TOOL_EXPIRY_S + 1)
  assert.equal(only(expired).state, 'expired')
  assert.equal(only(expired).endObserved, false)
})

test('readToolOutcome: explicit outcome wins over isError, unknown values fall back', () => {
  assert.equal(readToolOutcome({ outcome: 'cancelled', isError: true }), 'cancelled')
  assert.equal(readToolOutcome({ isError: true }), 'error')
  assert.equal(readToolOutcome({ outcome: 'bogus' }), 'complete')
  assert.equal(readToolOutcome({}), 'complete')
})

test('missing Post hook: an orphan stays running until the delay, then expires (not completed)', () => {
  let s = run([orch, start()])
  s = advance(s, 1 + TOOL_EXPIRY_S - 1)
  assert.equal(only(s).state, 'running')
  assert.ok(only(s).opacity > 0.5, 'a still-plausible running call is not faded away')
  s = advance(s, 1 + TOOL_EXPIRY_S + 1)
  const tc = only(s)
  assert.equal(tc.state, 'expired')
  assert.equal(tc.completeTime, 1 + TOOL_EXPIRY_S, 'expired at its deadline, independent of frame timing')
  assert.equal(tc.result, undefined, 'no result is invented')
  assert.notEqual(tc.state, 'complete')
})

test('the expiry delay is configurable', () => {
  const s = advance(run([orch, start()]), 7, { ...frameOptions, toolExpiryS: 5 })
  assert.equal(only(s).state, 'expired')
  const t = advance(run([orch, start()]), 20, { ...frameOptions, toolExpiryS: 60 })
  assert.equal(only(t).state, 'running')
})

test('an expired call stays visible for the minimum display time, then fades and is cleaned up', () => {
  let s = advance(run([orch, start()]), 1 + TOOL_EXPIRY_S + 1)
  assert.equal(only(s).state, 'expired')
  s = advance(s, 1 + TOOL_EXPIRY_S + TOOL_MIN_DISPLAY_S - 1)
  assert.equal(only(s).state, 'expired')
  assert.ok(only(s).opacity > 0.5)
  s = advance(s, s.currentTime + 30)
  assert.equal(s.toolCalls.size, 0)
})

test('expiry releases the agent from "calling tool" when nothing else is running', () => {
  const key = agentKeyOf('default', 'orchestrator')
  let s = run([orch, start()])
  assert.equal(s.agents.get(key)!.state, 'tool_calling')
  s = advance(s, 1 + TOOL_EXPIRY_S + 2)
  const a = s.agents.get(key)!
  assert.notEqual(a.state, 'tool_calling')
  assert.equal(a.currentTool, undefined)
})

test('expiry keeps the agent busy while another parallel call is still running', () => {
  const key = agentKeyOf('default', 'orchestrator')
  let s = run([orch, start('toolu_old', 1)])
  s = advance(s, 1 + TOOL_EXPIRY_S - 2)
  s = processEvent({ time: s.currentTime, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Grep', args: 'x', toolUseId: 'toolu_new' } }, s, ctx)
  s = advance(s, 1 + TOOL_EXPIRY_S + 2)
  const states = Array.from(s.toolCalls.values()).map(t => [t.toolUseId, t.state])
  assert.deepEqual(states.sort(), [['toolu_new', 'running'], ['toolu_old', 'expired']])
  assert.equal(s.agents.get(key)!.state, 'tool_calling')
})

test('a late end resolves an expired call with its real outcome (matched by tool_use_id)', () => {
  let s = advance(run([orch, start('toolu_1')]), 1 + TOOL_EXPIRY_S + 2)
  assert.equal(only(s).state, 'expired')
  s = processEvent({ time: s.currentTime, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Bash', toolUseId: 'toolu_1', result: 'late ok' } }, s, ctx)
  assert.equal(only(s).state, 'complete')
  assert.equal(only(s).endObserved, true)
  assert.equal(only(s).result, 'late ok')
})

test('an end without tool_use_id never claims an expired call', () => {
  let s = advance(run([orch, start('toolu_1')]), 1 + TOOL_EXPIRY_S + 2)
  const noId = { agent: 'orchestrator', tool: 'Bash', result: 'who knows' }
  s = processEvent({ time: s.currentTime, type: 'tool_call_end', payload: noId }, s, ctx)
  assert.equal(only(s).state, 'expired')
})

test('interrupted session: agent_complete leaves running calls expired, not completed', () => {
  const s = run([orch, start(), { type: 'agent_complete', time: 3, payload: { name: 'orchestrator' } }])
  const tc = only(s)
  assert.equal(tc.state, 'expired')
  assert.equal(tc.endObserved, false)
  assert.equal(tc.completeTime, 3)
})

test('interrupted session: sub-agent tools are expired with their agent', () => {
  const s = run([
    orch,
    { type: 'agent_spawn', time: 0.5, payload: { name: 'worker', parent: 'orchestrator' } },
    { type: 'tool_call_start', time: 1, payload: { agent: 'worker', tool: 'Read', args: 'a.ts', toolUseId: 'toolu_w' } },
    { type: 'agent_complete', time: 3, payload: { name: 'orchestrator' } },
  ])
  assert.equal(only(s).state, 'expired')
})

test('seeking past the delay snaps an orphan to expired', () => {
  const s = snapVisualState(run([orch, start()]), 1 + TOOL_EXPIRY_S + 1)
  assert.equal(only(s).state, 'expired')
  assert.equal(only(s).endObserved, false)
  const early = snapVisualState(run([orch, start()]), 5)
  assert.equal(only(early).state, 'running')
  assert.equal(only(early).opacity, 1)
})

test('warnings: expired and unobserved-end results carry a caveat, observed ones do not', () => {
  assert.equal(toolEndWarning({ state: 'expired', endObserved: false }), EXPIRED_WARNING)
  assert.match(toolEndWarning({ state: 'complete', endObserved: false }) ?? '', /fin non observée/)
  assert.equal(toolEndWarning({ state: 'complete', endObserved: true }), null)
  assert.equal(toolEndWarning({ state: 'running' }), null)
  assert.equal(TOOL_STATE_LABELS.expired, 'Expired')
})

test('a11y history keeps the outcome wording and the unobserved-end caveat after the card fades', async () => {
  const { updateToolHistory } = await import('../web/components/agent-visualizer/canvas/a11y-model')
  const s = advance(run([orch, start()]), 1 + TOOL_EXPIRY_S + 1)
  const history = updateToolHistory(new Map(), s.toolCalls)
  const entry = Array.from(history.values())[0]
  assert.equal(entry.state, 'expired')
  assert.equal(entry.warning, EXPIRED_WARNING)
  assert.equal(entry.result, '')
})
