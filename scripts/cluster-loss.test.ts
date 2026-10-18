// #366: the cost on a session or team halo is a lower bound ("at least") when the relay could not replay events of
// one of the sessions the halo counts; the halo of a session that lost nothing keeps its plain figure.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import type { TeamSummary } from '../web/lib/agent-types'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id.split(':')[1] ?? id, displayName: 'x', name: 'x',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 120_000, tokenStatus: 'available', tokensMax: 200_000,
    model: 'claude-sonnet-4',
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  }
}

const fleet = () => [
  agent({ id: 's1:main', sessionId: 's1', isMain: true, x: 0 }),
  agent({ id: 's2:main', sessionId: 's2', isMain: true, x: 2000 }),
]

test('without a loss the halo cost is the plain estimate', () => {
  const clusters = computeClusters(fleet())
  for (const c of clusters) {
    assert.match(c.costText, /^~\$/)
    assert.doesNotMatch(c.costSpoken, /at least/)
  }
  const none = computeClusters(fleet(), undefined, { replayLost: new Map() })
  assert.deepEqual(none.map(c => c.costText), clusters.map(c => c.costText))
})

test('the halo of a session that lost events reads "at least", the other one does not', () => {
  const clusters = computeClusters(fleet(), undefined, { replayLost: new Map([['s1', 7]]) })
  const s1 = clusters.find(c => c.key === 'session:s1')!
  const s2 = clusters.find(c => c.key === 'session:s2')!
  assert.match(s1.costText, /^at least ~\$/)
  assert.match(s1.costSpoken, /at least/)
  assert.match(s2.costText, /^~\$/, 'the loss of s1 is not s2\'s')
  assert.doesNotMatch(s2.costSpoken, /at least/)
  assert.equal(s1.cost, computeClusters(fleet()).find(c => c.key === 'session:s1')!.cost, 'the figure itself is unchanged, only qualified')
})

test('a loss of a session the tally does not name, or of a session outside the halo, changes nothing', () => {
  const clusters = computeClusters(fleet(), undefined, { replayLost: new Map([['other', 9]]) })
  for (const c of clusters) assert.match(c.costText, /^~\$/)
})

test('a team halo is a lower bound when any of its member sessions lost events, cost agents included', () => {
  const teams = new Map<string, TeamSummary>([
    ['alpha', { name: 'alpha', leadSessionId: 'L1', members: [{ name: 'a', sessionId: 'M1', color: '#aa0000' }] }],
  ])
  const drawn = [
    agent({ id: 'L1:lead', sessionId: 'L1', isMain: true, x: 0 }),
    agent({ id: 'M1:a', sessionId: 'M1', kind: 'teammate', teamName: 'alpha', x: 50 }),
  ]
  const lossOfMember = computeClusters(drawn, teams, { replayLost: new Map([['M1', 2]]) })
  assert.equal(lossOfMember.length, 1)
  assert.match(lossOfMember[0].costText, /^at least ~\$/)
  // The halo sums its cost over every agent of the simulation (a collapsed branch included): a hidden agent's session counts too
  const hidden = agent({ id: 'L1:sub', sessionId: 'L1', parentId: 'L1:lead', x: 10 })
  const viaCostAgents = computeClusters(drawn, teams, { costAgents: [...drawn, hidden], replayLost: new Map([['L1', 1]]) })
  assert.match(viaCostAgents[0].costText, /^at least ~\$/)
})
