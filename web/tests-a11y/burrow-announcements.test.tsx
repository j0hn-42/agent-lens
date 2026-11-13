// Burrow view: a screen reader user hears the same live announcements as on the node graph (same text, same
// announcement level, same polite and urgent regions). The burrow reuses the graph's state-change detection, it
// does not write its own messages.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, renderHook, act, cleanup, screen } from '@testing-library/react'

import { BurrowView } from '@/components/agent-visualizer/burrow-view'
import { useCanvasStateEffects } from '@/hooks/use-canvas-state-effects'
import type { Agent } from '@/lib/agent-types'
import type { AnnounceLevel } from '@/lib/ui-preferences'

afterEach(() => { cleanup(); document.body.replaceChildren() })

function agent(id: string, state: string): Agent {
  return { id, name: id, displayName: id, state, opacity: 1, x: 0, y: 0, sessionId: 's1', freshnessSource: 'live', lastEventAt: Date.now() } as unknown as Agent
}

const wait = (ms: number) => act(() => new Promise<void>((ok) => setTimeout(ok, ms)))

/** What the graph's own hook announces for the same two batches */
function graphAnnouncements(level: AnnounceLevel, first: Agent[], second: Agent[]) {
  const agents = new Map<string, Agent>()
  const set = (list: Agent[]) => { agents.clear(); for (const a of list) agents.set(a.id, a) }
  const hook = renderHook(() => useCanvasStateEffects({
    simulationRef: { current: { agents, toolCalls: new Map(), links: new Map() } } as never,
    drawPropsRef: { current: { agents } } as never,
    reducedMotionRef: { current: true },
    linksPropRef: { current: undefined },
    announceLevelRef: { current: level },
  }))
  set(first); act(() => hook.result.current.detectStateChanges())
  const before = new Set(hook.result.current.announcements.map(a => a.id))
  set(second); act(() => hook.result.current.detectStateChanges())
  // only what the second batch adds: the burrow takes the agents it finds on mount as its baseline
  const out = hook.result.current.announcements.filter(a => !before.has(a.id)).map(a => ({ text: a.text, urgent: a.urgent === true }))
  hook.unmount()
  return out
}

/** The burrow shown, the same two batches, then the text of its polite and urgent live regions */
async function burrowAnnouncements(level: AnnounceLevel, first: Agent[], second: Agent[], onMounted?: (polite: (string | null)[]) => void) {
  const agents = new Map<string, Agent>()
  const set = (list: Agent[]) => { agents.clear(); for (const a of list) agents.set(a.id, a) }
  const simulationRef = { current: { agents, toolCalls: new Map(), links: new Map(), discoveries: [] } }
  set(first)
  const view = render(
    <BurrowView
      simulationRef={simulationRef as never}
      selectedAgentId={null}
      announceLevel={level}
      onAgentClick={() => {}}
      onAgentHover={() => {}}
    />,
  )
  const texts = (el: Element) => Array.from(el.querySelectorAll('p')).map(p => p.textContent)
  const politeRegion = () => {
    const el = view.container.querySelector('[role="status"][aria-live="polite"]')
    assert.ok(el, 'the burrow has a polite live region')
    return el
  }
  await wait(400)
  onMounted?.(texts(politeRegion()))
  set(second)
  await wait(400)
  const urgent = screen.getByRole('alert')
  const polite = politeRegion()
  return { polite: texts(polite), urgent: texts(urgent) }
}

const first = [agent('Reviewer', 'idle'), agent('Builder', 'idle'), agent('Writer', 'thinking')]
const second = [agent('Reviewer', 'waiting_permission'), agent('Builder', 'error'), agent('Writer', 'complete')]

test('burrow: an agent asking for permission is announced with the graph\'s text, in the urgent region', async () => {
  const graph = graphAnnouncements('all', first, second)
  const burrow = await burrowAnnouncements('all', first, second)
  assert.ok(burrow.urgent.includes('Agent Reviewer is waiting for permission'))
  assert.deepEqual(burrow.urgent, graph.filter(a => a.urgent).map(a => a.text))
  assert.deepEqual(burrow.polite, graph.filter(a => !a.urgent).map(a => a.text))
  assert.ok(burrow.polite.length > 0, 'level "all" reads the calm changes too')
})

test('burrow: level "important" filters exactly as the graph does', async () => {
  const graph = graphAnnouncements('important', first, second)
  const burrow = await burrowAnnouncements('important', first, second)
  assert.deepEqual(burrow.urgent, ['Agent Reviewer is waiting for permission', 'Agent Builder failed'])
  assert.deepEqual(burrow.urgent, graph.filter(a => a.urgent).map(a => a.text))
  assert.deepEqual(burrow.polite, [])
  assert.deepEqual(graph.filter(a => !a.urgent), [])
})

test('burrow: agents already there when the view opens are not announced as started, later changes are', async () => {
  let onMount: (string | null)[] = []
  const burrow = await burrowAnnouncements('all', first, second, (polite) => { onMount = polite })
  assert.deepEqual(onMount, [], 'opening the burrow mid-session reads nothing: these agents did not just start')
  assert.ok(!burrow.polite.some(t => t?.includes('started')), 'no agent is announced as started')
  assert.ok(burrow.urgent.includes('Agent Reviewer is waiting for permission'), 'a later change is still announced')
})
