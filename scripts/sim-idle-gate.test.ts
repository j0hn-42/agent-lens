// #660: a simulation at rest does no work. The age of an agent is read from the clock (no copy of every agent at
// every frame), particles and discoveries keep their array when nothing moves, and a frame with nothing to do only
// advances the clock (idle gate). The gate is checked against computeNextFrame itself: a frame it skips is one that
// would have left every collection as it was.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { computeNextFrame, type AnimateOptions } from '../web/hooks/simulation/animate'
import { createForceLayout } from '../web/hooks/simulation/force-layout'
import { isSimulationIdle, idleFrame, type IdleGateInput } from '../web/hooks/simulation/idle-gate'
import { agentAge } from '../web/lib/agent-age'
import { ARCHIVED_OPACITY } from '../web/hooks/simulation/archive'
import { formatDuration } from '../web/lib/utils'
import { statsLabel } from '../web/components/agent-visualizer/canvas/loss-labels'
import { expiryHold, BUBBLE_VISIBLE_S, TOOL_MIN_DISPLAY_S, MOCK_END_BUFFER_S } from '../web/lib/canvas-constants'
import type { Discovery, Particle, ToolCallNode, SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
const options: AnimateOptions = { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0, toolExpiryS: 600 }
const DT = 1 / 60
const gateInput: IdleGateInput = { queued: false, layoutSettled: true, toolExpiryS: 600 }

afterEach(() => { expiryHold.neverHide = false; expiryHold.paused = false; expiryHold.agentIds.clear(); expiryHold.toolIds.clear(); expiryHold.discoveryIds.clear() })

/** A live scene at rest: `n` agents faded in, spawned at fractional times (real sessions), no particle, no bubble */
function restingScene(n = 3, spawnAt = 10.37): SimulationState {
  let s = createEmptyState()
  let t = spawnAt
  s = processEvent({ time: t, type: 'agent_spawn', sessionId: 's', payload: { name: 'main', isMain: true } }, { ...s, currentTime: t }, ctx)
  for (let i = 1; i < n; i++) {
    t += 0.173
    s = processEvent({ time: t, type: 'agent_spawn', sessionId: 's', payload: { name: `w${i}`, parent: 'main' } }, { ...s, currentTime: t }, ctx)
  }
  const agents = new Map([...s.agents].map(([id, a]) => [id, { ...a, opacity: 1, scale: 1, messageBubbles: [] }]))
  return { ...s, agents, particles: [], discoveries: [], edges: s.edges.map(e => ({ ...e, opacity: 1 })), toolCalls: new Map(), currentTime: t + 2, maxTimeReached: t + 2, isPlaying: true, eventLog: [], eventIndex: 0 }
}
const step = (s: SimulationState, dt = DT) => computeNextFrame(s, dt, s.currentTime + dt, Math.max(s.maxTimeReached, s.currentTime + dt), s, options)
/** The collections a skipped frame must leave as they are */
function sameCollections(a: SimulationState, b: SimulationState): boolean {
  return a.agents === b.agents && a.toolCalls === b.toolCalls && a.edges === b.edges && a.particles === b.particles
    && a.discoveries === b.discoveries && a.timelineEntries === b.timelineEntries && a.isPlaying === b.isPlaying
}
const idle = (s: SimulationState, input: Partial<IdleGateInput> = {}) => isSimulationIdle(s, s.currentTime + DT, { ...gateInput, ...input })

// ─── Age of an agent, read from the clock ───────────────────────────────────

test('the age of an agent is read from the clock, exact to the second (#660)', () => {
  const s = restingScene(1, 10.37)
  const a = [...s.agents.values()][0]
  assert.equal(agentAge(a, 10.37), 0)
  assert.equal(formatDuration(agentAge(a, 12.36)), '0:01')
  assert.equal(formatDuration(agentAge(a, 12.37)), '0:02')
  assert.equal(agentAge(a, 5), 0, 'never negative (clock restarted by Clear history)')
  const done = { ...a, state: 'complete' as const, completeTime: 70.37 }
  assert.equal(formatDuration(agentAge(done, 700)), '1:00', 'a complete agent keeps its lifetime')
  assert.equal(formatDuration(agentAge(done, 40.37)), '0:30', 'a seek before its end shows its age then')
})

test('the stats line shows the age at the time it is drawn for (#660)', () => {
  const a = [...restingScene(1, 10).agents.values()][0]
  assert.match(statsLabel(a, undefined, 72.5).text, /1:02$/)
  assert.match(statsLabel(a, undefined, 10).text, /0:00$/)
})

test('agents keep their identity frame after frame when nothing else changes, across second boundaries (#660)', () => {
  let s = restingScene(200)
  const agents = s.agents
  for (let i = 0; i < 510; i++) s = step(s)
  assert.equal(s.agents, agents, 'no copy of the agents in 510 frames (8.5 s) of rest')
  assert.ok(s.currentTime > restingScene(200).currentTime + 8, 'the clock moved')
})

test('a fading agent is still animated (the age change no longer hides it) (#660)', () => {
  const s0 = restingScene(1)
  const id = [...s0.agents.keys()][0]
  const s = { ...s0, agents: new Map([[id, { ...s0.agents.get(id)!, opacity: 0.5 }]]) }
  const next = step(s)
  assert.notEqual(next.agents, s.agents)
  assert.ok(next.agents.get(id)!.opacity > 0.5)
})

// ─── Particles and discoveries ──────────────────────────────────────────────

const particle = (progress: number): Particle => ({ id: 'p1', edgeId: 'e', progress, type: 'dispatch', color: '#fff', size: 2, trailLength: 0 })
const discovery = (over: Partial<Discovery> = {}): Discovery => ({
  id: 'd1', agentId: 'main', type: 'file', label: 'a.ts', content: '', x: 100, y: 100, targetX: 100, targetY: 100, opacity: 0.9, timestamp: 0, ...over,
})

test('no particle, no discovery: the same arrays come back (#660)', () => {
  const s = restingScene()
  const next = step(s)
  assert.equal(next.particles, s.particles)
  assert.equal(next.discoveries, s.discoveries)
})

test('a discovery at rest (in place, faded in, held) keeps its array; a moving one does not (#660)', () => {
  const s0 = restingScene()
  const still = { ...s0, discoveries: [discovery({ timestamp: s0.currentTime })] }
  assert.equal(step(still).discoveries, still.discoveries, 'in place and at full opacity during its hold: nothing moves')
  const moving = { ...s0, discoveries: [discovery({ timestamp: s0.currentTime, x: 0 })] }
  const next = step(moving)
  assert.notEqual(next.discoveries, moving.discoveries)
  assert.ok(next.discoveries[0].x > 0)
})

test('a discovery that reached its place to a hundredth of a pixel is snapped onto it, then stays put (#660)', () => {
  const s0 = restingScene()
  let s = { ...s0, discoveries: [discovery({ timestamp: s0.currentTime, x: 0, y: 0 })] }
  expiryHold.neverHide = true
  for (let i = 0; i < 600; i++) s = step(s)
  const d = s.discoveries[0]
  assert.equal(d.x, d.targetX)
  assert.equal(d.y, d.targetY)
  assert.equal(step(s).discoveries, s.discoveries)
})

test('a moving particle gives a new array, the same particle is advanced (#660)', () => {
  const s0 = restingScene()
  const s = { ...s0, particles: [particle(0.2)] }
  const next = step(s)
  assert.notEqual(next.particles, s.particles)
  assert.ok(next.particles[0].progress > 0.2)
})

// ─── Idle gate ──────────────────────────────────────────────────────────────

test('a scene at rest is idle, and computeNextFrame would indeed leave it as it is (#660)', () => {
  const s = restingScene(5)
  assert.equal(idle(s), true)
  assert.ok(sameCollections(s, step(s)))
})

test('the skipped frame still advances the clock, and nothing else (#660)', () => {
  const s = restingScene()
  const t = s.currentTime + DT
  const next = idleFrame(s, t, t)
  assert.equal(next.currentTime, t)
  assert.equal(next.maxTimeReached, t)
  assert.ok(sameCollections(s, next))
  // A thousand skipped frames: the clock keeps running (a received event is stamped and played against it)
  let r = s
  for (let i = 0; i < 1000; i++) { const nt = r.currentTime + DT; r = idleFrame(r, nt, Math.max(r.maxTimeReached, nt)) }
  assert.ok(Math.abs(r.currentTime - (s.currentTime + 1000 * DT)) < 1e-6)
})

test('a queued event, a pending log entry or a moving layout is never skipped (#660)', () => {
  const s = restingScene()
  assert.equal(idle(s, { queued: true }), false, 'external queue or catch-up backlog')
  assert.equal(idle(s, { layoutSettled: false }), false, 'layout in motion')
  const ev: SimulationEvent = { time: s.currentTime, type: 'message', payload: { agent: 'main', role: 'assistant', content: 'x' } }
  assert.equal(idle({ ...s, eventLog: [ev], eventIndex: 0 }), false, 'a log entry due now (after a seek back)')
  assert.equal(idle({ ...s, eventLog: [{ ...ev, time: s.currentTime + 10 }], eventIndex: 0 }), true, 'a later log entry waits for its time')
  assert.equal(idle({ ...s, eventLog: [ev], eventIndex: 1 }), true, 'already played')
})

test('particles, fades and pending removals are never skipped (#660)', () => {
  const s = restingScene()
  const [id, a] = [...s.agents][1]
  const withAgent = (over: object) => ({ ...s, agents: new Map(s.agents).set(id, { ...a, ...over }) })
  assert.equal(idle({ ...s, particles: [particle(0.5)] }), false, 'particle')
  assert.equal(idle(withAgent({ opacity: 0.4 })), false, 'agent fading in')
  assert.equal(idle(withAgent({ scale: 0.6 })), false, 'agent growing')
  assert.equal(idle(withAgent({ state: 'complete', completeTime: s.currentTime })), false, 'finished sub-agent fading out')
  assert.equal(idle(withAgent({ state: 'complete', completeTime: 1, opacity: 0, scale: 0.8 })), false, 'faded sub-agent to remove')
  assert.equal(idle(withAgent({ state: 'complete', completeTime: 1, archived: true, opacity: ARCHIVED_OPACITY, scale: 0.8 })), true, 'archived agent at its floor')
  assert.equal(idle({ ...s, edges: s.edges.map(e => ({ ...e, opacity: 0.5 })) }), false, 'edge fading in')
  assert.equal(idle({ ...s, discoveries: [discovery({ timestamp: s.currentTime, x: 0 })] }), false, 'discovery moving')
  assert.equal(idle({ ...s, discoveries: [discovery({ timestamp: s.currentTime })] }), true, 'discovery in place, in its hold')
  assert.equal(idle({ ...s, discoveries: [discovery({ timestamp: s.currentTime - 20 })] }), false, 'discovery past its hold fades out')
  // Every case above agrees with computeNextFrame
  for (const c of [withAgent({ opacity: 0.4 }), { ...s, particles: [particle(0.5)] }, { ...s, discoveries: [discovery({ timestamp: s.currentTime - 20 })] }]) {
    assert.equal(sameCollections(c, step(c)), false)
  }
})

test('the deadlines of the clock are kept: bubble expiry, tool expiry, minimum display of a card (#660)', () => {
  const s = restingScene()
  const [id, a] = [...s.agents][0]
  const bubble = (time: number) => ({ ...s, agents: new Map(s.agents).set(id, { ...a, messageBubbles: [{ text: 'hi', time, role: 'assistant' as const }] }) })
  assert.equal(idle(bubble(s.currentTime - 1)), true, 'a bubble still visible')
  assert.equal(idle(bubble(s.currentTime - BUBBLE_VISIBLE_S - 0.5)), false, 'a bubble to prune')
  expiryHold.agentIds.add(id)
  assert.equal(idle(bubble(s.currentTime - BUBBLE_VISIBLE_S - 0.5)), true, 'a held bubble does not expire')
  expiryHold.agentIds.clear()

  const tool = (over: Partial<ToolCallNode>): SimulationState => ({ ...s, toolCalls: new Map([['t1', {
    id: 't1', agentId: id, toolName: 'Bash', state: 'running', args: '', x: 0, y: 0, startTime: s.currentTime - 1, opacity: 1, ...over,
  } as ToolCallNode]]) })
  assert.equal(idle(tool({})), true, 'a running call before its expiry')
  assert.equal(idle(tool({ startTime: s.currentTime - 700 })), false, 'a running call past the expiry delay')
  assert.equal(idle(tool({ opacity: 0.5 })), false, 'a card fading in')
  assert.equal(idle(tool({ state: 'complete', completeTime: s.currentTime - 1 })), true, 'a done card in its minimum display')
  assert.equal(idle(tool({ state: 'complete', completeTime: s.currentTime - TOOL_MIN_DISPLAY_S - 1 })), false, 'a done card starting to fade out')
  expiryHold.toolIds.add('t1')
  assert.equal(idle(tool({ state: 'complete', completeTime: s.currentTime - TOOL_MIN_DISPLAY_S - 1 })), true, 'a held card stays')
  expiryHold.toolIds.clear()
  for (const c of [bubble(s.currentTime - BUBBLE_VISIBLE_S - 0.5), tool({ startTime: s.currentTime - 700 }), tool({ state: 'complete', completeTime: s.currentTime - TOOL_MIN_DISPLAY_S - 1 })]) {
    assert.equal(sameCollections(c, step(c)), false)
  }
  for (const c of [bubble(s.currentTime - 1), tool({}), tool({ state: 'complete', completeTime: s.currentTime - 1 })]) {
    assert.ok(sameCollections(c, step(c)))
  }
})

test('demo: the next scenario event and the end of the scenario are never skipped (#660)', () => {
  const s = restingScene()
  const t = s.currentTime
  const mock = (nextTime: number | undefined, eventIndex = 0, length = 10, endTime = t + 100) => idle({ ...s, eventIndex }, { mock: { length, endTime, nextTime } })
  assert.equal(mock(t + 5), true, 'next event later')
  assert.equal(mock(t), false, 'next event due')
  assert.equal(mock(undefined, 10, 10, t - MOCK_END_BUFFER_S - 1), false, 'scenario over: playback must stop')
  assert.equal(mock(undefined, 10, 10, t + 100), true, 'scenario over, buffer not elapsed')
})

// ─── Layout ─────────────────────────────────────────────────────────────────

test('the layout says when a step would move nothing, and wakes on a filter or kept-agent change (#660)', () => {
  const layout = createForceLayout()
  let s = layout.syncState(restingScene(6))
  for (let i = 0; i < 5000 && layout.active; i++) s = layout.stepState(s)
  s = layout.stepState(s)
  assert.equal(layout.isSettled(s), true)
  assert.equal(layout.stepState(s), s, 'a settled step changes nothing')
  assert.equal(layout.isSettled({ ...s, agents: new Map(s.agents) }), false, 'new agents map: one step to look at it')
  layout.setKeepIds(['s:w1'])
  assert.equal(layout.isSettled(s), false, 'kept agents changed')
  s = layout.stepState(s)
  for (let i = 0; i < 5000 && layout.active; i++) s = layout.stepState(s)
  s = layout.stepState(s)
  assert.equal(layout.isSettled(s), true)
  layout.setKeepIds(['s:w1'])
  assert.equal(layout.isSettled(s), true, 'the same kept agents again: still settled')
  layout.setHideInactive(true)
  assert.equal(layout.isSettled(s), false, 'filter toggled')
  layout.destroy()
})
