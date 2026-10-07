import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { sessionLinkSegments, clusterLinkNotes } from '../web/components/agent-visualizer/canvas/session-link-model'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'
import type { SessionLink } from '../web/lib/session-links'

const cl = (key: string, sessionIds: string[], cx: number, cy: number, r = 10) => ({ key, sessionIds, cx, cy, r })
const link = (parentId: string, childId: string, kind: SessionLink['kind'] = 'task'): SessionLink => ({ parentId, childId, kind })

test('a segment runs from the parent halo to the child halo', () => {
  const [seg] = sessionLinkSegments([cl('session:p', ['p'], 0, 0), cl('session:c', ['c'], 100, 0)], [link('p', 'c')])
  assert.equal(seg.key, 'sl:session:p>session:c')
  assert.deepEqual([seg.x1, seg.y1, seg.x2, seg.y2], [10, 0, 90, 0])
})

test('no segment when an end is not on screen, the halos overlap or both sessions share a cluster', () => {
  const two = [cl('session:p', ['p'], 0, 0), cl('session:c', ['c'], 100, 0)]
  assert.deepEqual(sessionLinkSegments(two, [link('p', 'missing')]), [])
  assert.deepEqual(sessionLinkSegments([cl('a', ['p'], 0, 0), cl('b', ['c'], 15, 0)], [link('p', 'c')]), [])
  assert.deepEqual(sessionLinkSegments([cl('team:x', ['p', 'c'], 0, 0), cl('other', ['z'], 100, 0)], [link('p', 'c')]), [])
  assert.deepEqual(sessionLinkSegments(two, []), [])
  assert.deepEqual(sessionLinkSegments([cl('only', ['p', 'c'], 0, 0)], [link('p', 'c')]), [])
})

test('several links between the same two clusters draw one segment', () => {
  const clusters = [cl('team:t', ['a', 'b'], 0, 0), cl('session:c', ['c', 'd'], 100, 0)]
  assert.equal(sessionLinkSegments(clusters, [link('a', 'c'), link('b', 'd', 'worktree')]).length, 1)
})

test('non-finite geometry yields no segment', () => {
  assert.deepEqual(sessionLinkSegments([cl('a', ['p'], 0, 0), cl('b', ['c'], NaN, 0)], [link('p', 'c')]), [])
})

test('cluster notes state both directions, with labels when known', () => {
  const clusters = [cl('session:p', ['p'], 0, 0), cl('session:c', ['c'], 100, 0)]
  const notes = clusterLinkNotes(clusters, [link('p', 'c', 'worktree')], new Map([['p', { label: 'Main' }], ['c', { label: 'Fix' }]]))
  assert.deepEqual(notes.get('session:c'), ['worktree of session Main'])
  assert.deepEqual(notes.get('session:p'), ['worktree session Fix'])
  assert.deepEqual([...clusterLinkNotes(clusters, [link('p', 'c')]).get('session:c')!], ['launched by session p'])
})

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(id: string, sessionId: string, x: number): any {
  return {
    id, agentKey: id, sessionId, localId: 'main', displayName: 'main', name: 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x, y: 0, vx: 0, vy: 0, pinned: false, isMain: true, kind: 'main',
    spawnTime: 0, lastActiveTime: 0, currentTool: undefined, opacity: 1,
  }
}

test('the DOM outline of a child cluster says who launched it', () => {
  const agents = new Map([['p:main', agent('p:main', 'p', 0)], ['c:main', agent('c:main', 'c', 400)]])
  const model = buildA11yModel(agents, new Map(), [], new Map(), {
    sessions: new Map([['p', { label: 'Main' }], ['c', { label: 'Fix' }]]),
    sessionLinks: [link('p', 'c')],
  })
  const child = model.clusters.find(c => c.key === 'session:c')!
  assert.match(child.text, /launched by session Main/)
  assert.doesNotMatch(model.clusters.find(c => c.key === 'session:p')!.text, /launched by/)
})
