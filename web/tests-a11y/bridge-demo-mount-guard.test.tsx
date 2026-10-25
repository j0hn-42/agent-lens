// useVSCodeBridge, real hook (#613): the mount branch of the demo. An entry that mounted before the scenario chunk
// loaded asks for it in an effect; a newer on/off request made before the chunk resolves (a relay or the bridge took
// over: `showDemo(false)`, `leaveDemo`) wins, so the late load neither turns the demo on nor seeds the tour sessions
// (the guard `demoRequestRef.current !== request`).
//
// A file of its own: the chunk must NOT be loaded when the hook mounts, and a loaded chunk stays loaded for the
// rest of the process (bridge-demo-and-all-buffer.test.tsx loads it in its first test).
import { test, afterEach, before } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'

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

test('mounted before the chunk, then "off" before it resolves: the late load turns nothing on and seeds no session', async () => {
  assert.equal(demo.isMockScenarioLoaded(), false, 'precondition: the chunk is not loaded')
  const { result } = renderHook(() => useVSCodeBridge())
  // The mount effect has asked for the chunk, which has not resolved yet: an "off" request arrives first
  act(() => { post({ type: 'config', config: { showMockData: false } }) })
  await act(async () => { await demo.loadMockScenario() })
  await tick()
  assert.equal(demo.isMockScenarioLoaded(), true, 'the chunk did load')
  assert.equal(result.current.useMockData, false, 'the newer "off" wins over the load started at mount')
  assert.equal(result.current.sessions.length, 0, 'the tour sessions are not declared either')
  assert.equal(result.current.selectedSessionId, null)
})
