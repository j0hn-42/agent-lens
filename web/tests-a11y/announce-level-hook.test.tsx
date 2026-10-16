// #379: the announcement level reaches the real useCanvasStateEffects hook through a ref read when a batch is queued.
// A burst of 10 changes with a permission request and a failure: both levels announce the urgent states.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useCanvasStateEffects } from '@/hooks/use-canvas-state-effects'
import type { Agent } from '@/lib/agent-types'
import type { AnnounceLevel } from '@/lib/ui-preferences'

afterEach(() => { cleanup(); document.body.replaceChildren() })

function agent(id: string, state: string): Agent {
  return { id, name: id, state, opacity: 1, x: 0, y: 0, sessionId: 's1', freshnessSource: 'live' } as unknown as Agent
}

function mount(level: AnnounceLevel) {
  const agents = new Map<string, Agent>()
  const simulationRef = { current: { agents, toolCalls: new Map(), links: new Map() } }
  const drawPropsRef = { current: { agents } }
  const levelRef = { current: level }
  const hook = renderHook(() => useCanvasStateEffects({
    simulationRef: simulationRef as never,
    drawPropsRef: drawPropsRef as never,
    reducedMotionRef: { current: true },
    linksPropRef: { current: undefined },
    announceLevelRef: levelRef,
  }))
  const setAgents = (list: Agent[]) => { agents.clear(); for (const a of list) agents.set(a.id, a) }
  return { hook, setAgents, levelRef }
}

for (const level of ['all', 'important'] as const) {
  test(`level ${level}: a burst of 10 changes keeps the permission request and the failure`, () => {
    const { hook, setAgents } = mount(level)
    const calm = Array.from({ length: 8 }, (_, i) => agent(`n${i}`, 'idle'))
    setAgents([...calm, agent('Reviewer', 'idle'), agent('Builder', 'idle')])
    act(() => hook.result.current.detectStateChanges())
    setAgents([...calm, agent('Reviewer', 'waiting_permission'), agent('Builder', 'error')])
    act(() => hook.result.current.detectStateChanges())
    const added = hook.result.current.announcements.filter(a => a.urgent).map(a => a.text)
    assert.deepEqual(added, ['Agent Reviewer is waiting for permission', 'Agent Builder failed'])
  })
}

test('"important" reads nothing for new agents; "all" does; the level is read at each batch', () => {
  const { hook, setAgents, levelRef } = mount('important')
  setAgents([agent('A', 'idle')])
  act(() => hook.result.current.detectStateChanges())
  assert.deepEqual(hook.result.current.announcements, [], 'important: a spawn is not announced')
  levelRef.current = 'all'
  setAgents([agent('A', 'idle'), agent('B', 'idle')])
  act(() => hook.result.current.detectStateChanges())
  assert.deepEqual(hook.result.current.announcements.map(a => a.text), ['Agent B started'])
})
