// #210: a burst of events (switch to 'All', relay replay, seek) is reduced with one copy of the collections
// per batch, only the touched agents are stamped, and the catch-up is cut into frame-sized slices.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, processEventBatch, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import { stampTouchedAgents } from '../web/hooks/simulation/freshness'
import { trackActiveTime } from '../web/hooks/simulation/track-active-time'
import { advanceActiveTime, isActiveState } from '../web/lib/active-time'
import { findToolSlot } from '../web/hooks/simulation/tool-slot'
import { createCatchUp, enqueueCatchUp, runCatchUpSlice, catchUpProgress } from '../web/hooks/simulation/catch-up'
import { burstEvents } from './fixtures/burst-events'
import type { Agent, SimulationEvent } from '../web/lib/agent-types'

function makeCtx(): ProcessEventContext {
  return {
    syncForceSimulation: () => {},
    findToolSlot,
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: true,
  }
}

const RECEIVED_AT = 1_700_000_000_000

// The per-event path the hook used before #210, kept here as the reference: full scans of the agents
function referenceStamp(prev: ReadonlyMap<string, Agent>, next: Map<string, Agent>, now: number): Map<string, Agent> {
  let out: Map<string, Agent> | null = null
  for (const [id, agent] of next) {
    if (prev.get(id) === agent) continue
    if (!out) out = new Map(next)
    out.set(id, { ...agent, lastEventAt: now, freshnessSource: 'live' })
  }
  return out ?? next
}
function referenceActive(prev: ReadonlyMap<string, Agent>, next: Map<string, Agent>, now: number): Map<string, Agent> {
  let out: Map<string, Agent> | null = null
  for (const [id, agent] of next) {
    if (prev.get(id) === agent) continue
    const working = isActiveState(agent.state)
    if (working === (agent.activeSince !== undefined)) continue
    const before = prev.get(id)
    if (working && before && isActiveState(before.state) && before.activeSince === undefined) continue
    const fields = advanceActiveTime({ activeMs: agent.activeMs, activeSince: agent.activeSince }, working, now)
    if (!out) out = new Map(next)
    const { activeMs: _ms, activeSince: _since, ...rest } = agent
    out.set(id, { ...rest, ...fields })
  }
  return out ?? next
}

/** Event by event, as the replay (seek) did it. */
function oneByOne(events: readonly SimulationEvent[], ctx: ProcessEventContext, start = createEmptyState()): SimulationState {
  let s = start
  for (const e of events) s = { ...processEvent(e, { ...s, currentTime: e.time }, ctx), currentTime: e.time }
  return s
}
/** Event by event, as the live path did it (freshness and active time after every event). */
function oneByOneLive(events: readonly SimulationEvent[], ctx: ProcessEventContext, now = RECEIVED_AT): SimulationState {
  let s = createEmptyState()
  for (const e of events) {
    s = { ...s, currentTime: e.time }
    const before = s
    s = processEvent(e, s, ctx)
    s = { ...s, agents: referenceStamp(before.agents, s.agents, now) }
    if (!e.replayed) s = { ...s, agents: referenceActive(before.agents, s.agents, now) }
  }
  return s
}

/** Comparable view of a state: conversation message ids come from a global counter, they are left out. */
function comparable(s: SimulationState) {
  return {
    agents: s.agents,
    toolCalls: s.toolCalls,
    timelineEntries: s.timelineEntries,
    conversations: new Map(Array.from(s.conversations, ([k, msgs]) => [k, msgs.map(({ id: _id, ...m }) => m)])),
    edges: s.edges,
    particles: s.particles,
    discoveries: s.discoveries,
    fileAttention: s.fileAttention,
    links: new Map(Array.from(s.links, ([k, l]) => [k, { ...l, messages: l.messages.map(({ id: _id, ...m }) => m) }])),
    teams: s.teams,
    unattributed: s.unattributed,
    droppedMessages: s.droppedMessages,
    currentTime: s.currentTime,
  }
}

const RICH: SimulationEvent[] = [
  { type: 'agent_spawn', payload: { name: 'lead', isMain: true, task: 'go' } },
  { type: 'subagent_dispatch', payload: { parent: 'lead', child: 'explorer', task: 'look', toolUseId: 'toolu_A' } },
  { type: 'agent_spawn', payload: { name: 'explorer', parent: 'lead', toolUseId: 'toolu_A' } },
  { type: 'tool_call_start', payload: { agent: 'explorer', tool: 'Read', args: 'a.ts', inputData: { file_path: 'a.ts' } } },
  { type: 'message', payload: { agent: 'explorer', role: 'assistant', content: 'reading' } },
  { type: 'tool_call_end', payload: { agent: 'explorer', tool: 'Read', result: 'ok' } },
  { type: 'tool_call_start', payload: { agent: 'lead', tool: 'Bash', args: 'x' } },
  { type: 'tool_call_end', payload: { agent: 'lead', tool: 'Bash', result: 'boom', isError: true } },
  { type: 'permission_requested', payload: { agent: 'lead', tool: 'Bash' } },
  { type: 'context_update', payload: { agent: 'lead', tokens: 1234 } },
  { type: 'subagent_return', payload: { parent: 'lead', child: 'explorer', summary: 'done' } },
  { type: 'agent_complete', payload: { name: 'explorer' } },
  { type: 'message_sent', payload: { from: 'lead', to: 'explorer', content: 'thanks' } },
  { type: 'agent_idle', payload: { name: 'lead' } },
  { type: 'agent_complete', payload: { name: 'lead' } },
].map((e, i) => ({ ...e, time: i + 1, sessionId: 's1' }) as SimulationEvent)

test('a batch gives the same agents, tool calls, conversations and timeline as event by event (replay)', () => {
  for (const events of [RICH, burstEvents(3000, 60)]) {
    const expected = oneByOne(events, makeCtx())
    const { state, processed } = processEventBatch(events, createEmptyState(), makeCtx(), { advanceClock: true })
    assert.equal(processed, events.length)
    assert.deepStrictEqual(comparable(state), comparable(expected))
  }
})

test('a live batch stamps freshness and active time exactly like the per-event path', () => {
  const events = burstEvents(3000, 60).map((e, i) => (i % 7 === 0 ? { ...e, replayed: true } : e))
  for (const list of [RICH, events]) {
    const expected = oneByOneLive(list, makeCtx())
    const { state } = processEventBatch(list, createEmptyState(), makeCtx(), { advanceClock: true, receivedAt: RECEIVED_AT })
    assert.deepStrictEqual(comparable(state), comparable(expected))
  }
})

test('a batch never mutates the previous state and keeps the references of untouched collections', () => {
  const prev = oneByOne(RICH.slice(0, 6), makeCtx())
  const frozen = JSON.stringify(comparable(prev), (_k, v) => (v instanceof Map ? Array.from(v) : v))
  const ctx = makeCtx()
  ctx.blockIdCounter.current = 1000
  const { state } = processEventBatch(RICH.slice(6, 8), prev, ctx, { advanceClock: true })
  assert.equal(JSON.stringify(comparable(prev), (_k, v) => (v instanceof Map ? Array.from(v) : v)), frozen)
  assert.notEqual(state.toolCalls, prev.toolCalls)
  assert.equal(state.links, prev.links, 'no link event: same Map')
  assert.equal(state.teams, prev.teams, 'no team event: same Map')
  assert.equal(Object.getPrototypeOf(state.agents), Map.prototype, 'a plain Map is published')
  assert.equal(processEventBatch([], prev, makeCtx()).state, prev, 'an empty batch is the previous state')
})

test('without advanceClock the batch keeps the clock of the previous state (log replay as time passes)', () => {
  const start = createEmptyState({ currentTime: 42 })
  const expected = RICH.reduce((s, e) => processEvent(e, s, makeCtx()), start)
  const { state } = processEventBatch(RICH, start, makeCtx())
  assert.equal(state.currentTime, 42)
  assert.deepStrictEqual(state.agents.size, expected.agents.size)
})

test('stampTouchedAgents only visits the agents the event touched', () => {
  const a: Agent = { id: 'a', state: 'idle' } as Agent
  const b: Agent = { id: 'b', state: 'idle' } as Agent
  const prev = new Map([['a', a], ['b', b]])
  // Both objects differ from prev, only 'a' is declared touched
  const next = new Map([['a', { ...a, state: 'thinking' }], ['b', { ...b }]])
  const out = stampTouchedAgents(prev, next, 5, ['a'])
  assert.equal(out.get('a')!.lastEventAt, 5)
  assert.equal(out.get('b')!.lastEventAt, undefined, 'b is not visited')
  // Only the touched ids are looked up (the copy-on-write of the result is the one pass over the map)
  const visited: string[] = []
  const spy = new Proxy(next, {
    get(target, key) {
      const v = Reflect.get(target, key, target)
      return typeof v === 'function' ? (...args: unknown[]) => { if (key === 'get') visited.push(String(args[0])); return v.apply(target, args) } : v
    },
  })
  stampTouchedAgents(prev, spy, 5, ['a'])
  assert.deepEqual(visited, ['a'])
})

test('trackActiveTime only visits the agents the event touched', () => {
  const prev = new Map<string, Agent>([['a', { id: 'a', state: 'idle' } as Agent], ['b', { id: 'b', state: 'idle' } as Agent]])
  const next = new Map<string, Agent>([['a', { id: 'a', state: 'thinking' } as Agent], ['b', { id: 'b', state: 'thinking' } as Agent]])
  const out = trackActiveTime(prev, next, 1000, ['a'])
  assert.equal(out.get('a')!.activeSince, 1000)
  assert.equal(out.get('b')!.activeSince, undefined, 'b is not visited')
})

test('the catch-up is cut into frame slices and ends with the same state as event by event', () => {
  const events = burstEvents(4000, 80)
  const expected = oneByOneLive(events, makeCtx())
  const queue = createCatchUp()
  enqueueCatchUp(queue, events.slice(0, 1500), RECEIVED_AT)
  enqueueCatchUp(queue, events.slice(1500), RECEIVED_AT)
  assert.deepEqual(catchUpProgress(queue), { done: 0, total: 4000 })
  let state = createEmptyState()
  const ctx = makeCtx()
  let slices = 0
  let clock = 0
  // A fake clock: every event costs 1 ms, the budget is 8 ms, so a slice holds 8 events
  const now = () => clock++
  while (catchUpProgress(queue)) {
    const before = catchUpProgress(queue)!.done
    const r = runCatchUpSlice(queue, state, ctx, { budgetMs: 8, now })
    state = r.state
    slices++
    assert.ok(r.processed.length >= 1, 'every slice moves forward')
    const after = catchUpProgress(queue)
    if (after) assert.equal(after.done, before + r.processed.length)
  }
  assert.ok(slices > 100, `cut into many slices (${slices})`)
  assert.deepStrictEqual(comparable(state), comparable(expected))
})

test('perf: 10 000 events on 300 agents in under 500 ms in total, no frame over 50 ms', () => {
  const events = burstEvents(10_000, 300)
  // Warm-up (JIT) on another batch, so the measure is the steady cost
  processEventBatch(burstEvents(2000, 50), createEmptyState(), makeCtx(), { advanceClock: true, receivedAt: RECEIVED_AT })

  const queue = createCatchUp()
  enqueueCatchUp(queue, events, RECEIVED_AT)
  let state = createEmptyState()
  const ctx = makeCtx()
  const frames: number[] = []
  while (catchUpProgress(queue)) {
    const t0 = performance.now()
    state = runCatchUpSlice(queue, state, ctx, { budgetMs: 8, now: () => performance.now() }).state
    frames.push(performance.now() - t0)
  }
  const total = frames.reduce((a, b) => a + b, 0)
  const worst = Math.max(...frames)
  assert.equal(state.agents.size, 300)
  assert.ok(total < 500, `total ${total.toFixed(0)} ms`)
  assert.ok(worst < 50, `worst frame ${worst.toFixed(1)} ms`)

  // The whole burst in one batch (seek) also stays under the budget
  const t0 = performance.now()
  processEventBatch(events, createEmptyState(), makeCtx(), { advanceClock: true })
  const oneBatch = performance.now() - t0
  assert.ok(oneBatch < 500, `one batch ${oneBatch.toFixed(0)} ms`)
})
