import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeClusterAnchors, clusterRadius, type ClusterInput } from '../web/hooks/simulation/fleet-layout'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import {
  MAX_ORPHAN_CONVERSATIONS, MAX_AGENTS_TOTAL, MAX_LINKS_TOTAL,
} from '../web/hooks/simulation/archive'
import { MAX_TEAMS, eventMatchesSelection, createTeamTracker } from '../web/hooks/simulation/team-info'
import {
  activeSessionIds, finishedSessionIds, visibilityKey, parseShowFinished, finishedToggleLabel, ACTIVE_WINDOW_MS,
} from '../web/hooks/simulation/session-visibility'
import { ALL_SESSIONS_ID } from '../web/lib/bridge-types'
import { CLUSTER_LAYOUT } from '../web/lib/canvas-constants'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }
function run(events: Ev[], from: SimulationState = createEmptyState()): SimulationState {
  let state = from
  let t = 1
  for (const e of events) state = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: t++ }, ctx)
  return state
}
const main = (sessionId: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'agent_spawn', sessionId, payload: { name: 'main', isMain: true, ...extra } })

// ─── 'All' shows only active sessions (#36) ─────────────────────────────────

const NOW = 10_000_000
const sess = (id: string, status: 'active' | 'completed', ageMs: number, teamName?: string) =>
  ({ id, status, lastActivityTime: NOW - ageMs, ...(teamName ? { teamName } : {}) })

test('active rule: status active, recent activity, selected session', () => {
  const sessions = [
    sess('live', 'active', 60 * 60_000),
    sess('recent', 'completed', ACTIVE_WINDOW_MS - 1000),
    sess('old', 'completed', ACTIVE_WINDOW_MS + 1000),
    sess('picked', 'completed', 24 * 60 * 60_000),
  ]
  const ids = activeSessionIds({ sessions, selectedId: 'picked', now: NOW })
  assert.deepEqual([...ids].sort(), ['live', 'picked', 'recent'])
  assert.deepEqual(finishedSessionIds(sessions, ids), ['old'])
})

test('active rule: an event in the last 10 minutes revives an old session, also one only known from events', () => {
  const sessions = [sess('old', 'completed', 3 * 60 * 60_000)]
  const lastEventAt = new Map([['old', NOW - 5_000], ['ghost', NOW - 1_000], ['stale', NOW - ACTIVE_WINDOW_MS - 1]])
  const ids = activeSessionIds({ sessions, lastEventAt, now: NOW })
  assert.deepEqual([...ids].sort(), ['ghost', 'old'])
})

test('active rule: members of a team with a working member are shown', () => {
  const sessions = [sess('lead', 'completed', 99 * 60_000), sess('m1', 'completed', 99 * 60_000), sess('x', 'completed', 99 * 60_000, 'beta'), sess('lone', 'completed', 99 * 60_000)]
  const teamSessions = new Map([['alpha', new Set(['lead', 'm1'])], ['beta', new Set<string>()]])
  const working = activeSessionIds({ sessions, teamSessions, teamWorking: new Map([['alpha', 1], ['beta', 2]]), now: NOW })
  assert.deepEqual([...working].sort(), ['lead', 'm1', 'x'])
  const idle = activeSessionIds({ sessions, teamSessions, teamWorking: new Map([['alpha', 0], ['beta', 0]]), now: NOW })
  assert.equal(idle.size, 0)
})

test('active rule: garbage times never throw and count as old', () => {
  const sessions = [{ id: 'a', status: 'completed' as const, lastActivityTime: Number.NaN }]
  assert.equal(activeSessionIds({ sessions, lastEventAt: new Map([['a', Number.NaN]]), now: NOW }).size, 0)
})

test('visibility helpers: key, preference parsing, toggle label', () => {
  assert.equal(visibilityKey(null), '*')
  assert.equal(visibilityKey(new Set(['b', 'a'])), visibilityKey(new Set(['a', 'b'])))
  assert.notEqual(visibilityKey(new Set(['a'])), visibilityKey(new Set(['a', 'b'])))
  assert.equal(parseShowFinished('true'), true)
  for (const v of [null, undefined, '', 'false', '1', 'TRUE']) assert.equal(parseShowFinished(v), false)
  assert.equal(finishedToggleLabel(3), 'Show finished sessions (3)')
})

test("'All' delivery: finished sessions are excluded only while the filter is given; teams and single tabs unaffected", () => {
  const tracker = createTeamTracker()
  const sessions = [{ id: 'live' }, { id: 'old' }]
  const visible = new Set(['live'])
  assert.equal(eventMatchesSelection(ALL_SESSIONS_ID, 'live', tracker, sessions, visible), true)
  assert.equal(eventMatchesSelection(ALL_SESSIONS_ID, 'old', tracker, sessions, visible), false)
  assert.equal(eventMatchesSelection(ALL_SESSIONS_ID, 'old', tracker, sessions, null), true)
  assert.equal(eventMatchesSelection(ALL_SESSIONS_ID, 'old', tracker, sessions), true)
  assert.equal(eventMatchesSelection(ALL_SESSIONS_ID, undefined, tracker, sessions, visible), true)
  // a finished session stays available through its own tab
  assert.equal(eventMatchesSelection('old', 'old', tracker, sessions, visible), true)
})

// ─── tighter ring (#36) ─────────────────────────────────────────────────────

function anchorsOf(clusters: ClusterInput[]) { return Array.from(computeClusterAnchors(clusters).values()) }

test('no overlap for 1..40 clusters, equal and mixed sizes', () => {
  for (let n = 1; n <= 40; n++) {
    for (const sizeOf of [() => 1, (i: number) => 1 + (i % 5) * 3, (i: number) => (i === 0 ? 60 : 2)]) {
      const clusters = Array.from({ length: n }, (_, i) => ({ key: `c${i}`, size: sizeOf(i) }))
      const a = anchorsOf(clusters)
      assert.equal(a.length, n)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const d = Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y)
          assert.ok(d >= a[i].radius + a[j].radius, `n=${n}: discs ${i},${j} overlap (${d.toFixed(1)})`)
        }
      }
    }
  }
})

test('ring: neighbouring discs just touch plus the gap, and the ring only grows with more clusters', () => {
  let prevR = 0
  for (let n = 3; n <= CLUSTER_LAYOUT.maxRingClusters; n++) {
    const a = anchorsOf(Array.from({ length: n }, (_, i) => ({ key: `c${i}`, size: 3 })))
    const r = clusterRadius(3)
    const dist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y)
    assert.ok(dist >= 2 * r + CLUSTER_LAYOUT.gap - 1, `n=${n} neighbours closer than touching + gap (${dist})`)
    assert.ok(dist <= 2 * r + CLUSTER_LAYOUT.gap + 2, `n=${n} ring looser than needed (${dist})`)
    const R = Math.hypot(a[0].x, a[0].y)
    assert.ok(R >= prevR - 1e-6, `ring shrank at n=${n}`)
    assert.ok(a[0].y < 0, 'first cluster keeps the top slot')
    prevR = R
  }
})

test('disc radius uses the tighter spacing: 17 single-agent sessions fit a modest area', () => {
  const a = anchorsOf(Array.from({ length: 17 }, (_, i) => ({ key: `c${i}`, size: 2 })))
  const extent = Math.max(...a.map(p => Math.hypot(p.x, p.y) + p.radius))
  assert.ok(extent < 6000, `17 clusters span a radius of ${Math.round(extent)}`)
})

// ─── bounded simulation: events for agents that are not in state.agents (#40) ─

test('probe: 50k events for 10k unknown agent names stay under the cap', () => {
  let state: SimulationState = run([main('s')])
  let t = 10
  const roles = ['assistant', 'user', 'thinking']
  const batch: Ev[] = []
  for (let i = 0; i < 50_000; i++) {
    const name = `ghost${i % 10_000}`
    const k = i % 5
    batch.push(
      k === 0 ? { type: 'message', sessionId: 's', payload: { agent: name, role: roles[i % 3], content: `m${i}` } }
      : k === 1 ? { type: 'subagent_dispatch', sessionId: 's', payload: { parent: 'main', child: name, task: 't', toolUseId: `tu${i}` } }
      : k === 2 ? { type: 'subagent_return', sessionId: 's', payload: { parent: 'main', child: name, summary: 'r' } }
      : k === 3 ? { type: 'message_sent', sessionId: 's', payload: { from: name, to: `peer${i % 10_000}`, content: 'hi', linkId: `l${i}` } }
      : { type: 'tool_call_start', sessionId: 's', payload: { agent: name, tool: 'Read', args: 'a' } },
    )
  }
  let maxConv = 0
  let maxLinks = 0
  for (const e of batch) {
    state = processEvent({ time: t, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: t++ }, ctx)
    if (state.conversations.size > maxConv) maxConv = state.conversations.size
    if (state.links.size > maxLinks) maxLinks = state.links.size
  }
  const cap = state.agents.size + MAX_ORPHAN_CONVERSATIONS + 64
  assert.ok(maxConv <= cap, `conversations peaked at ${maxConv} (cap ${cap})`)
  assert.ok(maxLinks <= MAX_LINKS_TOTAL, `links peaked at ${maxLinks}`)
  assert.ok(state.timelineEntries.size <= state.agents.size)
  assert.ok(state.droppedMessages.size <= state.conversations.size)
  assert.equal(state.toolCalls.size, 0, 'no tool call for an unknown agent')
  assert.ok(state.particles.length <= 500)
  assert.ok(state.agents.size <= MAX_AGENTS_TOTAL)
})

test('refused spawns do not leave conversations behind without bound', () => {
  const evs: Ev[] = [main('s')]
  for (let i = 0; i < 405; i++) evs.push({ type: 'agent_spawn', sessionId: 's', payload: { name: `w${i}`, parent: 'main' } })
  let s = run(evs)
  const agents = s.agents.size
  const flood: Ev[] = []
  for (let i = 0; i < 3000; i++) {
    const child = `late${i}`
    flood.push(
      { type: 'subagent_dispatch', sessionId: 's', payload: { parent: 'main', child, task: 'x' } },
      { type: 'agent_spawn', sessionId: 's', payload: { name: child, parent: 'main' } },
      { type: 'message', sessionId: 's', payload: { agent: child, role: 'assistant', content: 'hi' } },
      { type: 'subagent_return', sessionId: 's', payload: { parent: 'main', child, summary: 'done' } },
    )
  }
  s = run(flood, s)
  assert.equal(s.agents.size, agents, 'spawns beyond the cap are refused')
  assert.ok(s.conversations.size <= s.agents.size + MAX_ORPHAN_CONVERSATIONS + 64, `${s.conversations.size} conversations for ${s.agents.size} agents`)
})

test('orphan eviction keeps the most recently updated conversations and never touches agents', () => {
  const evs: Ev[] = [main('s')]
  for (let i = 0; i < 400; i++) evs.push({ type: 'message', sessionId: 's', payload: { agent: `u${i}`, role: 'assistant', content: 'x' } })
  const s = run(evs)
  assert.ok(s.conversations.has('s:u399'))
  assert.ok(!s.conversations.has('s:u0'))
  assert.ok(s.agents.has('s:main'))
})

test('leads with a team name are never refused by the team gates', () => {
  const evs: Ev[] = []
  for (let i = 0; i < MAX_TEAMS + 20; i++) evs.push(main(`lead${i}`, { kind: 'teammate', teamName: `team-${i}` }))
  const s = run(evs)
  assert.equal(Array.from(s.agents.values()).filter(a => a.isMain).length, MAX_TEAMS + 20)
})
