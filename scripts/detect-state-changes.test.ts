// Expanding a collapsed branch reveals agents that did not just start: no "started" announcement (#55).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { detectStateChanges } from '../web/components/agent-visualizer/canvas/detect-state-changes'
import type { Agent, ToolCallNode } from '../web/lib/agent-types'

const ag = (name: string, state: Agent['state'] = 'complete') => ({ name, state, x: 0, y: 0, opacity: 1 }) as unknown as Agent

test('agents entering the scene (branch expanded) are not announced as spawned', () => {
  const all = new Map([['main', ag('main', 'idle')], ['a1', ag('a1')], ['a2', ag('a2')]])
  const collapsed = new Map([['main', all.get('main')!]])
  const noTools = new Map<string, ToolCallNode>()
  const first = detectStateChanges(all, noTools, new Map(), new Map(), collapsed)
  assert.deepEqual(first.transitions.filter(t => t.kind === 'agent_spawn').map(t => t.id), ['main'])
  const second = detectStateChanges(all, noTools, first.newAgentStates, first.newToolStates, all)
  assert.deepEqual(second.transitions, [])
  assert.equal(second.effects.length, 0)
})

test('without a shown set every agent is reported, as before', () => {
  const all = new Map([['a1', ag('a1')]])
  const r = detectStateChanges(all, new Map(), new Map(), new Map())
  assert.deepEqual(r.transitions.map(t => t.kind), ['agent_spawn'])
})
