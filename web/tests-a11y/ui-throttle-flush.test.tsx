// #213: the React state is throttled to 4 commits per second, but a commit skipped by the throttle is caught up
// later: panels, inspector and lists never stay on an older state than the canvas once the session goes quiet.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { agentKeyOf } from '@/hooks/simulation/types'
import { observedSessions } from '@/lib/session-model'
import type { SimulationEvent } from '@/lib/agent-types'

const T0 = 1_700_000_000_000
const FRAME_MS = 20
const UI_THROTTLE_MS = 250

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
  mock.timers.reset()
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  observedSessions.clear()
})

let consumed = 0
const pending: SimulationEvent[] = []
/** Times (Date.now) at which the hook published a new React state (one per setState of the simulation state) */
let commits: number[] = []

function mount() {
  pending.length = 0
  commits = []
  let lastTime: number | null = null
  const view = renderHook(() => {
    const sim = useAgentSimulation({
      useMockData: false, externalEvents: pending, sessionFilter: null,
      onExternalEventsConsumed: () => { consumed++; pending.length = 0 },
    })
    // The clock advances on every frame: a new currentTime in a render means a new state was committed
    if (sim.isPlaying && lastTime !== null && sim.currentTime !== lastTime) commits.push(Date.now())
    lastTime = sim.currentTime
    return sim
  })
  act(() => { view.result.current.play() })
  return view
}
const frame = () => act(() => { mock.timers.tick(FRAME_MS) })
/** Runs the frames up to `at` (Date.now), not one millisecond further */
function runUntil(at: number) {
  while (Date.now() < at) { const step = Math.min(FRAME_MS, at - Date.now()); act(() => { mock.timers.tick(step) }) }
}
function send(events: SimulationEvent[]) {
  consumed = 0
  pending.push(...events)
  for (let i = 0; i < 5 && consumed === 0; i++) frame()
  assert.equal(consumed, 1, 'consumed by one frame')
}

const KEY = agentKeyOf('s1', 'main')

test('two batches 100 ms apart, then silence: the React state shows the second batch within 250 ms', () => {
  const view = mount()
  send([
    { sessionId: 's1', time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true, task: 't' } },
    { sessionId: 's1', time: 0.1, type: 'tool_call_start', payload: { agent: 'main', tool: 'Read', args: 'x.ts' } },
  ])
  assert.equal(view.result.current.agents.get(KEY)?.state, 'tool_calling', 'the first batch is committed at once')

  for (let i = 0; i < 100 / FRAME_MS; i++) frame()
  // End of a turn, then the session goes quiet
  send([
    { sessionId: 's1', time: 0.2, type: 'tool_call_end', payload: { agent: 'main', tool: 'Read', result: 'ok' } },
    { sessionId: 's1', time: 0.3, type: 'message', payload: { agent: 'main', role: 'assistant', content: 'Done.' } },
    { sessionId: 's1', time: 0.4, type: 'agent_idle', payload: { name: 'main', turnEnd: true } },
  ])
  const receivedAt = Date.now()
  assert.equal(view.result.current.frameRef.current.agents.get(KEY)?.state, 'idle', 'the canvas already shows the second batch')

  runUntil(receivedAt + UI_THROTTLE_MS)
  const r = view.result.current
  assert.equal(r.agents.get(KEY)?.state, 'idle', 'the inspector no longer shows the agent tool_calling')
  assert.equal(r.agents.get(KEY)?.currentTool, undefined)
  assert.deepEqual(r.conversations.get(KEY)?.map(m => m.content), ['Done.'], 'the conversation panel shows the last message')
  assert.equal(r.toolCalls.size, view.result.current.frameRef.current.toolCalls.size)

  // Nothing new: the caught-up state is not re-published on every frame
  const settled = commits.length
  for (let i = 0; i < 1000 / FRAME_MS; i++) frame()
  assert.equal(commits.length, settled, 'no commit without new events once caught up')
})

test('a continuous flow of events commits the React state at most 4 times per second', () => {
  const view = mount()
  send([{ sessionId: 's1', time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true, task: 't' } }])
  const start = Date.now()
  let n = 0
  // One event every frame for 3 s
  while (Date.now() - start < 3000) {
    n++
    send([{ sessionId: 's1', time: n * 0.02, type: 'message', payload: { agent: 'main', role: 'assistant', content: `m${n}` } }])
  }
  const during = commits.filter(t => t >= start)
  assert.ok(during.length >= 3 * 3, `the state keeps following the flow (${during.length} commits)`)
  for (let i = 0; i < during.length; i++) {
    const inWindow = during.filter(t => t >= during[i] && t < during[i] + 1000).length
    assert.ok(inWindow <= 4, `${inWindow} commits in the second starting at +${during[i] - start} ms`)
  }
  // And the last message reaches the state once the flow stops
  const stoppedAt = Date.now()
  runUntil(stoppedAt + UI_THROTTLE_MS)
  assert.equal(view.result.current.conversations.get(KEY)?.at(-1)?.content, `m${n}`)
})
