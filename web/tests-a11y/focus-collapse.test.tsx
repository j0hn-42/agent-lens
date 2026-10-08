// Le focus clavier épingle la branche ouverte comme une sélection (issue #103).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { createCollapseMemory, evaluateCollapse, focusOwners } from '@/components/agent-visualizer/canvas/branch-collapse'
import type { Agent, ToolCallNode, Discovery } from '@/lib/agent-types'

const agent = (id: string, parentId: string | null, state: string): Agent => ({ id, parentId, state } as unknown as Agent)
const tools = new Map<string, ToolCallNode>([['t1', { id: 't1', agentId: 'sub' } as ToolCallNode]])
const discoveries = [{ id: 'd1', agentId: 'leaf' } as unknown as Discovery]

test('focusOwners: agent, outil et découverte focalisés renvoient leur agent propriétaire', () => {
  assert.deepEqual(focusOwners({ type: 'agent', id: 'a' }, tools, discoveries), ['a'])
  assert.deepEqual(focusOwners({ type: 'tool', id: 't1' }, tools, discoveries), ['sub'])
  assert.deepEqual(focusOwners({ type: 'discovery', id: 'd1' }, tools, discoveries), ['leaf'])
  assert.deepEqual(focusOwners({ type: 'tool', id: 'gone' }, tools, discoveries), [])
  assert.deepEqual(focusOwners(null, tools, discoveries), [])
})

test('une branche inactive se replie, sauf si l\'agent focalisé est dedans', () => {
  const agents = new Map([
    ['root', agent('root', null, 'thinking')],
    ['sub', agent('sub', 'root', 'complete')],
    ['leaf', agent('leaf', 'sub', 'complete')],
  ])
  assert.ok(evaluateCollapse(agents, createCollapseMemory(), []).hidden.has('leaf'))
  const pinned = evaluateCollapse(agents, createCollapseMemory(), focusOwners({ type: 'agent', id: 'leaf' }, tools, discoveries))
  assert.equal(pinned.hidden.has('leaf'), false)
})
