import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeClusters, clusterLabelLines, clusterAnnouncement, effectiveClusterState } from '../web/components/agent-visualizer/canvas/cluster-model'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id.split(':')[1] ?? id, displayName: 'x', name: 'x',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  }
}

test('team halo status reads the teammates activity, not only agent.state', () => {
  const lead = agent({ id: 's1:lead', isMain: true, teamName: 'alpha', kind: 'main', state: 'idle', x: 0 })
  const mate = agent({ id: 's1:mate', kind: 'teammate', teamName: 'alpha', state: 'idle', activity: 'working', x: 100 })
  const [c] = computeClusters([lead, mate])
  assert.equal(c.kind, 'team')
  assert.equal(c.status, 'working')
  assert.equal(c.statusText, 'working')
})

test('effectiveClusterState: teammate activity maps to a state; errors and permission waits win', () => {
  assert.equal(effectiveClusterState(agent({ kind: 'teammate', state: 'idle', activity: 'working' })), 'thinking')
  assert.equal(effectiveClusterState(agent({ kind: 'teammate', state: 'thinking', activity: 'idle' })), 'idle')
  assert.equal(effectiveClusterState(agent({ kind: 'teammate', state: 'idle', activity: 'done' })), 'complete')
  assert.equal(effectiveClusterState(agent({ kind: 'teammate', state: 'error', activity: 'working' })), 'error')
  assert.equal(effectiveClusterState(agent({ kind: 'teammate', state: 'waiting_permission', activity: 'idle' })), 'waiting_permission')
  // Not a teammate: activity is ignored
  assert.equal(effectiveClusterState(agent({ kind: 'subagent', state: 'idle', activity: 'working' })), 'idle')
  assert.equal(effectiveClusterState(agent({ kind: 'teammate', state: 'thinking' })), 'thinking')
})

test('all teammates done and lead complete: the halo is complete', () => {
  const lead = agent({ id: 's1:lead', isMain: true, teamName: 'alpha', state: 'complete' })
  const mate = agent({ id: 's1:mate', kind: 'teammate', teamName: 'alpha', state: 'idle', activity: 'done', x: 50 })
  assert.equal(computeClusters([lead, mate])[0].status, 'complete')
})

test('session halo title uses the label of the sessions prop (and workspace / runtime), not the raw id', () => {
  const a = agent({ id: 'sess-a:main', sessionId: 'sess-a', isMain: true })
  const b = agent({ id: 'sess-a:sub', sessionId: 'sess-a', x: 80 })
  const other = agent({ id: 'sess-b:main', sessionId: 'sess-b', isMain: true, x: 900 })
  const sessions = new Map([['sess-a', { label: 'payments-api', workspace: 'payments', runtime: 'codex' as const }]])
  const clusters = computeClusters([a, b, other], undefined, { sessions })
  const ca = clusters.find(c => c.sessionIds.includes('sess-a'))!
  const cb = clusters.find(c => c.sessionIds.includes('sess-b'))!
  assert.equal(ca.title, 'payments-api')
  assert.equal(clusterLabelLines(ca).title, 'Session payments-api (2)')
  assert.match(clusterLabelLines(ca).detail, /payments/)
  assert.match(clusterAnnouncement(ca), /workspace payments/)
  assert.equal(cb.title, 'sess-b', 'a session without metadata falls back to its id')
  // Hostile metadata is cleaned
  const evil = computeClusters([a, b], undefined, { sessions: new Map([['sess-a', { label: '\u001b[31m' + 'x'.repeat(200) }]]) })
  assert.ok(evil[0].title.length <= 40)
  assert.ok(!/[\u0000-\u001f]/.test(evil[0].title))
})
