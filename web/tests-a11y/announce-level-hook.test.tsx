// #379: the announcement level reaches the real useCanvasStateEffects hook through a ref read when a batch is queued.
// A burst where all 10 agents change (8 complete, a permission request, a failure): "all" reads the two
// urgent states and a summary of the 8 others, "important" reads only the two urgent states.
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

/** Ten agents, then a second batch where all ten change: 8 complete, one asks for permission, one fails. Returns what that batch added. */
function burst(hook: ReturnType<typeof mount>['hook'], setAgents: (list: Agent[]) => void) {
  const ids = Array.from({ length: 8 }, (_, i) => `n${i}`)
  setAgents([...ids.map(id => agent(id, 'idle')), agent('Reviewer', 'idle'), agent('Builder', 'idle')])
  act(() => hook.result.current.detectStateChanges())
  const lastId = Math.max(0, ...hook.result.current.announcements.map(a => a.id))
  setAgents([...ids.map(id => agent(id, 'complete')), agent('Reviewer', 'waiting_permission'), agent('Builder', 'error')])
  act(() => hook.result.current.detectStateChanges())
  return hook.result.current.announcements.filter(a => a.id > lastId)
}

test('a burst of 10 changes: "all" reads the two urgent states and a summary of the rest', () => {
  const { hook, setAgents } = mount('all')
  const added = burst(hook, setAgents)
  assert.deepEqual(added.filter(a => a.urgent).map(a => a.text), ['Agent Reviewer is waiting for permission', 'Agent Builder failed'])
  assert.deepEqual(added.filter(a => !a.urgent).map(a => a.text), ['8 agent graph updates'])
})

test('a burst of 10 changes: "important" reads exactly the two urgent states, nothing calm', () => {
  const { hook, setAgents } = mount('important')
  const added = burst(hook, setAgents)
  assert.deepEqual(added.map(a => ({ text: a.text, urgent: a.urgent === true })), [
    { text: 'Agent Reviewer is waiting for permission', urgent: true },
    { text: 'Agent Builder failed', urgent: true },
  ])
})

test('"important" reads nothing for new agents; "all" does; the level is read at each batch', () => {
  const { hook, setAgents, levelRef } = mount('important')
  setAgents([agent('A', 'idle')])
  act(() => hook.result.current.detectStateChanges())
  assert.equal(hook.result.current.announcements.length, 0, 'important: a spawn is not announced')
  levelRef.current = 'all'
  setAgents([agent('A', 'idle'), agent('B', 'idle')])
  act(() => hook.result.current.detectStateChanges())
  assert.deepEqual(hook.result.current.announcements.map(a => a.text), ['Agent B started'])
})
