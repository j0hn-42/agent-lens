import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { visibleAgents, parseHideInactive } from '../web/lib/inactive-agents'
import type { Agent } from '../web/lib/agent-types'

const mk = (id: string, state: Agent['state'], parentId: string | null = null, archived = false) =>
  ({ id, state, parentId, archived }) as unknown as Agent

const agents = new Map<string, Agent>([
  ['main', mk('main', 'idle')],
  ['a', mk('a', 'tool_calling', 'main')],
  ['b', mk('b', 'complete', 'main')],
  ['c', mk('c', 'idle', 'b')],
  ['d', mk('d', 'thinking', null, true)],
])

test('returns the same map when the filter is off', () => {
  assert.equal(visibleAgents(agents, false), agents)
})

test('hides idle/complete/archived agents but keeps ancestors of active ones', () => {
  assert.deepEqual([...visibleAgents(agents, true).keys()], ['main', 'a'])
})

test('keeps the selected agent and its ancestors', () => {
  assert.deepEqual([...visibleAgents(agents, true, ['c']).keys()], ['main', 'a', 'b', 'c'])
})

test('returns the same map when nothing is hidden', () => {
  const live = new Map([['x', mk('x', 'thinking')]])
  assert.equal(visibleAgents(live, true), live)
})

test('parseHideInactive: hidden by default, only "false" shows them', () => {
  assert.equal(parseHideInactive(null), true)
  assert.equal(parseHideInactive('true'), true)
  assert.equal(parseHideInactive('false'), false)
})
