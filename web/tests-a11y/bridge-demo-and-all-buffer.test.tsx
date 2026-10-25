// useVSCodeBridge, real hook (#613): (1) the demo turns on when its scenario chunk is there, also for an entry that
// mounted before it loaded (#662): the tour then declares its sessions as it does when the chunk is loaded at mount,
// and a late "load" never turns the demo back on after a newer "off"; (2) the arrival-order buffer of the All tab is
// trimmed in batches (#659), not one splice per event.
//
// A file of its own: the scenario chunk must NOT be loaded when the hook mounts, and `?scenario=tour` is read once,
// when demo-scenario is first imported, so the hook is imported after the variable is set.
import { test, afterEach, before } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

type Hook = typeof import('@/hooks/use-vscode-bridge').useVSCodeBridge
type Demo = typeof import('@/lib/demo-scenario')
let useVSCodeBridge: Hook
let demo: Demo

before(async () => {
  process.env.NEXT_PUBLIC_DEMO_SCENARIO = 'tour'
  delete (process.env as Record<string, string | undefined>).NEXT_PUBLIC_DEMO
  demo = await import('@/lib/demo-scenario')
  useVSCodeBridge = (await import('@/hooks/use-vscode-bridge')).useVSCodeBridge
})

afterEach(() => { cleanup(); document.body.replaceChildren() })

const post = (data: unknown) => vscodeBridge!.dispatch(data)
const tick = () => act(async () => { await new Promise(res => setTimeout(res, 0)) })
const info = (id: string) => ({ id, label: id, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now() })
const ev = (sessionId: string, time: number) => ({
  type: 'agent_spawn', time, payload: { name: `main-${sessionId}`, isMain: true }, sessionId,
})

// One test mounts before the chunk is there, then the chunk loads: the tests after it find it loaded
test('mounted before the scenario chunk: no demo yet, then the demo and the tour sessions once it is loaded', async () => {
  assert.equal(demo.isMockScenarioLoaded(), false, 'precondition: the chunk is not loaded')
  assert.equal(demo.HAS_MOCK_SESSIONS, true, 'precondition: the tour scenario')
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(result.current.useMockData, false, 'nothing of the demo is claimed before it is loaded')
  assert.equal(result.current.sessions.length, 0)
  await act(async () => { await demo.loadMockScenario() })
  await tick()
  assert.equal(result.current.useMockData, true)
  assert.ok(result.current.sessions.length > 0, 'the tour declares its sessions, as when the chunk is loaded at mount')
  assert.equal(result.current.selectedSessionId, ALL_SESSIONS_ID)
})

test('a demo request that resolves after a newer "off" does not turn the demo back on', async () => {
  // The chunk is loaded now, so use a deferred one through the config message and a real bridge "off" right after
  const { result } = renderHook(() => useVSCodeBridge())
  await tick()
  act(() => { post({ type: 'config', config: { showMockData: false } }) })
  assert.equal(result.current.useMockData, false)
  act(() => { post({ type: 'config', config: { showMockData: true } }); post({ type: 'config', config: { showMockData: false } }) })
  await tick()
  assert.equal(result.current.useMockData, false, 'the last request wins, even though the load of the first resolves later')
  act(() => { post({ type: 'config', config: { showMockData: true } }) })
  await tick()
  assert.equal(result.current.useMockData, true)
})

// The cap is 50 000 events, trimmed once the buffer is 10 % over it: a flush of the All view shows how many are kept
const CAP = 50_000
const SLACK = 5_000

function allEvents(count: number, from: number) {
  return Array.from({ length: count }, (_, i) => ({ type: 'agent-event', event: ev('a', from + i) }))
}

test('the All buffer is trimmed in a batch once 10 % over its cap, not one splice per event', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  act(() => { post({ type: 'session-list', sessions: [info('a')] }) })
  act(() => { result.current.selectSession(ALL_SESSIONS_ID) })
  act(() => { result.current.flushSessionEvents(ALL_SESSIONS_ID) })
  // Live events of the selection fill the pending queue, which a flush rebuilds from the buffer: consume them
  act(() => { for (const m of allEvents(CAP + 2_000, 0)) post(m) })
  act(() => { result.current.flushSessionEvents(ALL_SESSIONS_ID) })
  assert.equal(result.current.pendingEvents.length, CAP + 2_000, 'under cap + 10 %: nothing trimmed yet (a splice per event would hold 50 000)')

  act(() => { for (const m of allEvents(SLACK - 2_000 + 1, CAP + 2_000)) post(m) })
  act(() => { result.current.flushSessionEvents(ALL_SESSIONS_ID) })
  assert.equal(result.current.pendingEvents.length, CAP, 'one event past cap + 10 %: back to the cap in one go')

  // Positions stay absolute: from the position of the last 100 events, exactly those are replayed
  const total = CAP + SLACK + 1
  act(() => { result.current.flushSessionEvents(ALL_SESSIONS_ID, total - 100) })
  assert.equal(result.current.pendingEvents.length, 100)
})
