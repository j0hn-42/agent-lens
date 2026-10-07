import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  deriveInspectorView, nextInspectorMemory, countAgentToolErrors, goneText, type InspectorMemory,
} from '../web/lib/inspector-model'
import { STALE_AFTER_MS } from '../web/lib/canvas-constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
const T0 = 1_700_000_000_000
function agent(id: string, over: Record<string, unknown> = {}): any {
  return { id, agentKey: id, sessionId: id.split(':')[0], name: id, state: 'thinking', toolCalls: 0, tokensUsed: 0, ...over }
}
function tool(id: string, agentId: string, state = 'complete'): any { return { id, agentId, state } }

// Anchor session s1 is fresh and noisy; the peer s2 is stale and quiet: the inspector must show the peer's own values
const anchor = agent('s1:main', { lastEventAt: T0, freshnessSource: 'live', toolCalls: 12, state: 'tool_calling' })
const peer = agent('s2:main', { lastEventAt: T0 - 5 * STALE_AFTER_MS, freshnessSource: 'live', toolCalls: 1, state: 'idle' })
const agents = new Map<string, any>([[anchor.id, anchor], [peer.id, peer]])
const tools = new Map<string, any>([
  ['t1', tool('t1', 's1:main', 'error')], ['t2', tool('t2', 's1:main', 'error')], ['t3', tool('t3', 's2:main', 'error')], ['t4', tool('t4', 's2:main')],
])

test('a peer shows its own freshness, clock and errors, not the anchor ones', () => {
  const v = deriveInspectorView('s2:main', agents, tools, null, T0)
  assert.equal(v.kind, 'agent')
  if (v.kind !== 'agent') return
  assert.equal(v.agent, peer)
  assert.equal(v.freshness, 'stale')
  assert.equal(v.lastEventAt, T0 - 5 * STALE_AFTER_MS)
  assert.equal(v.toolErrors, 1)
  const a = deriveInspectorView('s1:main', agents, tools, null, T0)
  assert.ok(a.kind === 'agent' && a.freshness === 'fresh' && a.toolErrors === 2 && a.lastEventAt === T0)
})

test('a peer never observed stays never-observed even when the anchor is live', () => {
  const ghost = agent('s3:main')
  const v = deriveInspectorView('s3:main', new Map([[anchor.id, anchor], [ghost.id, ghost]]), tools, null, T0)
  assert.ok(v.kind === 'agent' && v.freshness === 'never-observed' && v.lastEventAt === null && v.toolErrors === 0)
})

test('no selection: nothing to inspect', () => {
  assert.deepEqual(deriveInspectorView(null, agents, tools, null, T0), { kind: 'none' })
})

test('a selection that disappears is reported as gone, with its last known name and no substituted values', () => {
  let mem: InspectorMemory | null = nextInspectorMemory(null, 's2:main', { name: 'Reviewer' })
  const without = new Map(agents); without.delete('s2:main')
  assert.equal(nextInspectorMemory(mem, 's2:main', undefined), mem, 'memory survives the disappearance')
  const v = deriveInspectorView('s2:main', without, tools, mem, T0)
  assert.deepEqual(v, { kind: 'gone', id: 's2:main', name: 'Reviewer' })
  assert.equal(goneText('Reviewer'), 'Reviewer is no longer listed')
  assert.equal(goneText(null), 'This node is no longer listed')
  mem = null
})

test('rapid selection change: memory never leaks the previous node name', () => {
  let mem = nextInspectorMemory(null, 's1:main', { name: 'Anchor' })
  mem = nextInspectorMemory(mem, 's2:main', undefined)
  assert.equal(mem, null, 'the new selection is unknown: no name rather than the previous one')
  assert.deepEqual(deriveInspectorView('s2:main', new Map(), tools, mem, T0), { kind: 'gone', id: 's2:main', name: null })
  // even a stale memory object for another id is ignored by the view
  assert.deepEqual(deriveInspectorView('s2:main', new Map(), tools, { id: 's1:main', name: 'Anchor' }, T0), { kind: 'gone', id: 's2:main', name: null })
  assert.equal(nextInspectorMemory(mem, null, undefined), null)
})

test('rapid selection change: every view comes from the selected id only, in any order', () => {
  const order = ['s1:main', 's2:main', 's1:main', 's2:main', 's2:main', 's1:main']
  let mem: InspectorMemory | null = null
  for (const id of order) {
    mem = nextInspectorMemory(mem, id, agents.get(id))
    const v = deriveInspectorView(id, agents, tools, mem, T0)
    assert.ok(v.kind === 'agent' && v.agent.id === id)
    assert.equal(v.toolErrors, id === 's1:main' ? 2 : 1)
  }
})

test('memory follows renames of the same node', () => {
  const m1 = nextInspectorMemory(null, 'x', { name: 'old' })
  const m2 = nextInspectorMemory(m1, 'x', { name: 'new' })
  assert.equal(m2?.name, 'new')
  assert.equal(nextInspectorMemory(m2, 'x', { name: 'new' }), m2, 'identity is stable when nothing changed')
})

test('countAgentToolErrors counts only the given agent and only errors', () => {
  assert.equal(countAgentToolErrors('s1:main', tools), 2)
  assert.equal(countAgentToolErrors('nobody', tools), 0)
})
