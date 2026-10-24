import './all-locales' // #662: the tables are loaded on demand, every one is loaded before the tests
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeClusters, clusterLabelLines, clusterAnnouncement, effectiveClusterState } from '../web/components/agent-visualizer/canvas/cluster-model'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'

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

test('halo cost counts agents the display hides (collapsed branch), geometry stays on the drawn ones (#106)', () => {
  const lead = agent({ id: 's1:main', isMain: true, tokensUsed: 80_000, tokenStatus: 'available', x: 0 })
  const peer = agent({ id: 's1:peer', tokensUsed: 20_000, tokenStatus: 'available', x: 100 })
  const hidden = agent({ id: 's1:hidden', parentKey: 's1:peer', tokensUsed: 120_000, tokenStatus: 'available', x: 50 })
  const drawn = computeClusters([lead, peer])
  const all = computeClusters([lead, peer], undefined, { costAgents: [lead, peer, hidden] })
  assert.ok(all[0].cost! > drawn[0].cost!, 'the hidden agent adds to the halo cost')
  assert.equal(all[0].memberIds.length, 2, 'only drawn agents are members')
  assert.equal(all[0].cx, drawn[0].cx)
  const unknownHidden = agent({ id: 's1:u', tokenStatus: 'unavailable', tokensUsed: 0 })
  const q = computeClusters([lead, peer], undefined, { costAgents: [lead, peer, unknownHidden] })
  assert.match(q[0].costText, /^at least /, 'a hidden agent with no data makes the halo a lower bound')
})

// ─── #367 a halo never states a stale status as current ─────────────────────

test('a halo whose working agents are stale says "last known", not "working" (#367)', () => {
  const now = 1_700_000_000_000
  const old = now - 10 * 60_000
  const main = agent({ id: 's1:main', isMain: true, state: 'thinking', lastEventAt: old, freshnessSource: 'live' })
  const sub = agent({ id: 's1:sub', state: 'waiting_permission', lastEventAt: old, freshnessSource: 'live', x: 80 })
  const [c] = computeClusters([main, sub], undefined, { now })
  assert.equal(c.statusText, 'last known: waiting for permission')
  assert.match(clusterAnnouncement(c), /last known: waiting for permission/)
  // Without a clock the status reads as before
  assert.equal(computeClusters([main, sub])[0].statusText, 'waiting for permission')
})

test('a halo keeps the proven status of its fresh agents and adds a higher stale one as last known (#367)', () => {
  const now = 1_700_000_000_000
  const fresh = agent({ id: 's1:main', isMain: true, state: 'thinking', lastEventAt: now - 1_000, freshnessSource: 'live' })
  const staleWait = agent({ id: 's1:sub', state: 'waiting_permission', lastEventAt: now - 10 * 60_000, freshnessSource: 'live', x: 80 })
  assert.equal(computeClusters([fresh, staleWait], undefined, { now })[0].statusText, 'working, last known: waiting for permission')
  const staleIdle = agent({ id: 's1:sub', state: 'idle', lastEventAt: now - 10 * 60_000, freshnessSource: 'live', x: 80 })
  assert.equal(computeClusters([fresh, staleIdle], undefined, { now })[0].statusText, 'working')
})

test('a team halo with a stale working teammate is not announced as working (#367)', () => {
  const now = 1_700_000_000_000
  const old = now - 10 * 60_000
  const lead = agent({ id: 's1:lead', isMain: true, teamName: 'alpha', kind: 'main', state: 'idle', lastEventAt: old, freshnessSource: 'live' })
  const mate = agent({ id: 's1:mate', kind: 'teammate', teamName: 'alpha', state: 'idle', activity: 'working', lastEventAt: old, freshnessSource: 'live', x: 100 })
  const [c] = computeClusters([lead, mate], undefined, { now })
  assert.equal(c.kind, 'team')
  assert.equal(c.statusText, 'last known: working')
})

test('the outline cluster heading carries the last known halo status (#367)', () => {
  const now = 1_700_000_000_000
  const old = now - 10 * 60_000
  const main = agent({ id: 's1:main', isMain: true, state: 'thinking', lastEventAt: old, freshnessSource: 'live' })
  const sub = agent({ id: 's1:sub', state: 'thinking', lastEventAt: old, freshnessSource: 'live', x: 80 })
  const model = buildA11yModel(new Map([[main.id, main], [sub.id, sub]]), new Map(), [], new Map(), { now })
  assert.match(model.clusters[0].text, /last known: working/)
  assert.doesNotMatch(model.clusters[0].text, /, working,/)
})
