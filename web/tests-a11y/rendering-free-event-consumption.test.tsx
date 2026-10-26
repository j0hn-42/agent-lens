// The rAF loop of the REAL useAgentSimulation consumes events pushed in place into the queue it was given,
// without any re-render of its host (#645): the bridge no longer re-renders per event.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import type { SimulationEvent } from '@/lib/agent-types'

const FRAME_MS = 20
const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 })
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => { act(() => { cb(Date.now()) }) }, FRAME_MS) as unknown as number
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
})
afterEach(() => {
  cleanup(); mock.timers.reset()
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
})

test('an event pushed in place into the queue is consumed by the next frames, with no rerender', () => {
  const queue: SimulationEvent[] = []
  let consumed = 0
  const view = renderHook(() => useAgentSimulation({
    useMockData: false, externalEvents: queue, sessionFilter: null,
    onExternalEventsConsumed: () => { consumed++; queue.length = 0 },
  }))
  act(() => { view.result.current.play() })
  queue.push({ sessionId: 's', time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true, task: 't' } })
  for (let i = 0; i < 6; i++) act(() => { mock.timers.tick(FRAME_MS) })
  assert.equal(consumed, 1, 'consumed once')
  const names = [...view.result.current.frameRef.current.agents.values()].map(a => a.localId)
  assert.deepEqual(names, ['main'], 'the agent exists in the frame')
})
