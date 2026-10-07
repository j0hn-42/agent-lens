// Team clusters with two same-named teams under different lead sessions (#36): membership, colour and
// halo status come from the right team, and a teammate that works by activity makes its team work.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import type { TeamSummary } from '../web/lib/agent-types'

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

// Two teams called "alpha": the first keeps the plain key, the second is suffixed with its lead session
const teams = new Map<string, TeamSummary>([
  ['alpha', { name: 'alpha', leadSessionId: 'L1', members: [{ name: 'a', sessionId: 'M1', color: '#aa0000' }] }],
  ['alpha@L2', { name: 'alpha', leadSessionId: 'L2', members: [{ name: 'b', sessionId: 'M2', color: '#00aa00' }] }],
])
const fleet = (over: { m1?: Record<string, unknown>; m2?: Record<string, unknown>; l2?: Record<string, unknown> } = {}) => [
  agent({ id: 'L1:lead', sessionId: 'L1', isMain: true, x: 0 }),
  agent({ id: 'M1:a', sessionId: 'M1', kind: 'teammate', teamName: 'alpha', x: 50, ...over.m1 }),
  agent({ id: 'L2:lead', sessionId: 'L2', isMain: true, x: 2000, ...over.l2 }),
  agent({ id: 'M2:b', sessionId: 'M2', kind: 'teammate', teamName: 'alpha', x: 2050, ...over.m2 }),
]

test('a teammate of the second same-named team joins the cluster of its own lead session', () => {
  const clusters = computeClusters(fleet(), teams)
  assert.deepEqual(clusters.map(c => c.key), ['team:L1:alpha', 'team:L2:alpha'])
  assert.deepEqual(clusters[0].memberIds.sort(), ['L1:lead', 'M1:a'])
  assert.deepEqual(clusters[1].memberIds.sort(), ['L2:lead', 'M2:b'], 'not split into a team:M2:alpha cluster')
})

test('each same-named team takes its colour from its own summary', () => {
  const clusters = computeClusters(fleet(), teams)
  assert.deepEqual(clusters.map(c => c.color), ['#aa0000', '#00aa00'])
})

test('a teammate idle by state but working by activity makes only its own team work', () => {
  const clusters = computeClusters(fleet({ m2: { state: 'idle', activity: 'working' } }), teams)
  assert.deepEqual(clusters.map(c => [c.key, c.status]), [['team:L1:alpha', 'idle'], ['team:L2:alpha', 'working']])
  assert.equal(clusters[1].statusText, 'working')
  // The activity counts whatever the member's kind (teamHaloStatus reads state + activity only)
  const other = computeClusters(fleet({ m2: { kind: 'subagent', state: 'idle', activity: 'working' } }), teams)
  assert.equal(other.find(c => c.key === 'team:L2:alpha')!.status, 'working')
})

test('team halo status: any working teammate wins over idle ones; errors and permission waits still win', () => {
  const working = computeClusters(fleet({ m1: { state: 'idle', activity: 'idle' }, l2: { state: 'thinking' }, m2: { state: 'idle', activity: 'idle' } }), teams)
  assert.equal(working.find(c => c.key === 'team:L2:alpha')!.status, 'working', 'the lead works')
  const waiting = computeClusters(fleet({ m2: { state: 'waiting_permission', activity: 'working' } }), teams)
  assert.equal(waiting.find(c => c.key === 'team:L2:alpha')!.status, 'waiting')
  const error = computeClusters(fleet({ m2: { state: 'error', activity: 'working' } }), teams)
  assert.equal(error.find(c => c.key === 'team:L2:alpha')!.status, 'error')
})

test('a team whose members are all done is complete', () => {
  const clusters = computeClusters(fleet({ l2: { state: 'complete' }, m2: { state: 'idle', activity: 'done' } }), teams)
  assert.equal(clusters.find(c => c.key === 'team:L2:alpha')!.status, 'complete')
})
