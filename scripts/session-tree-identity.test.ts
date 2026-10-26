// #658: buildAgentForests keeps the identity of the nodes whose agent and subtree did not change.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildAgentForests, type AgentLike } from '../web/lib/session-tree'

const agent = (id: string, sessionId: string, parentKey: string | null, spawnTime = 0): AgentLike => ({
  id, sessionId, parentKey, name: id, state: 'idle', tokensUsed: 0, spawnTime,
})

test('a node whose agent and subtree did not change keeps its identity', () => {
  const main = agent('s1:main', 's1', null, 1)
  const sub = agent('s1:sub', 's1', 's1:main', 2)
  const other = agent('s2:main', 's2', null, 1)
  const first = buildAgentForests([main, sub, other])
  // sub changed (new object), main and other did not
  const sub2 = { ...sub, tokensUsed: 5 }
  const second = buildAgentForests([main, sub2, other], first)
  assert.notEqual(second.get('s1')![0], first.get('s1')![0], 'the parent of a changed child is rebuilt')
  assert.notEqual(second.get('s1')![0].children[0], first.get('s1')![0].children[0], 'the changed node is rebuilt')
  assert.equal(second.get('s2')![0], first.get('s2')![0], 'an untouched session keeps its node')
  assert.equal(second.get('s2'), first.get('s2'), 'and its roots array')
  const third = buildAgentForests([main, sub2, other], second)
  assert.equal(third.get('s1')![0], second.get('s1')![0], 'nothing changed: every node is the previous one')
  assert.equal(third.get('s1')![0].children[0], second.get('s1')![0].children[0])
})

test('the reused tree equals a fresh one when a parent changes', () => {
  const a = agent('s1:a', 's1', null, 1)
  const b = agent('s1:b', 's1', 's1:a', 2)
  const first = buildAgentForests([a, b])
  const b2 = { ...b, parentKey: null }
  const reused = buildAgentForests([a, b2], first)
  assert.deepEqual(reused.get('s1')!.map(n => [n.agent.id, n.children.length]), [['s1:a', 0], ['s1:b', 0]])
})

test('an agent leaving the list leaves no stale node', () => {
  const a = agent('s1:a', 's1', null, 1)
  const b = agent('s1:b', 's1', 's1:a', 2)
  const first = buildAgentForests([a, b])
  const second = buildAgentForests([a], first)
  assert.equal(second.get('s1')![0].children.length, 0)
  assert.equal(buildAgentForests([], second).size, 0)
})
