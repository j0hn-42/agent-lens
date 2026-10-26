/**
 * #652: the relay's replay buffer costs O(1) amortised per append once it is full. It is trimmed in batches (back
 * down to 90 % of its cap, in one pass), and the latest agent_activity of an agent is found through an index instead
 * of a scan of the whole buffer. The events kept, their order and the events handed over as evicted are those of
 * the event-by-event trim (same victims, oldest chatter first), only taken in one go.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { appendBounded, trimKeepingLifecycle, createEvictedTally } from '../src/relay-guards'
import { RELAY_REPLAY_LIFECYCLE_RESERVE } from '../src/constants'

const LIFECYCLE = new Set(['agent_spawn', 'subagent_dispatch', 'team_info'])

/** The event-by-event trim as it was before #652: the reference the batched trim must match. */
function referenceTrim(buf: AgentEvent[], max: number, out: AgentEvent[]): void {
  while (buf.length > max) {
    let lifecycle = 0
    let victim = -1
    for (let i = 0; i < buf.length; i++) {
      if (LIFECYCLE.has(buf[i].type)) { lifecycle++; continue }
      if (buf[i].type === 'agent_activity') continue
      victim = i
      break
    }
    if (victim < 0 || lifecycle > RELAY_REPLAY_LIFECYCLE_RESERVE) victim = 0
    out.push(buf.splice(victim, 1)[0])
  }
}

/** Deterministic pseudo-random sequence (no flaky test). */
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}

const TYPES: AgentEvent['type'][] = ['agent_spawn', 'team_info', 'subagent_dispatch', 'agent_activity', 'message', 'tool_call_start', 'tool_call_end']
function randomEvents(n: number, rand: () => number, lifecycleShare: number): AgentEvent[] {
  return Array.from({ length: n }, (_, i) => {
    const r = rand()
    const type = r < lifecycleShare ? TYPES[Math.floor(rand() * 3)] : TYPES[3 + Math.floor(rand() * 4)]
    return { time: i, type, payload: { name: `a${Math.floor(rand() * 20)}`, i } }
  })
}

describe('batched trim of the replay buffer (#652)', () => {
  it('trims down to the target in one call, with the victims and the order of the event-by-event trim', () => {
    const rand = rng(652)
    for (let round = 0; round < 200; round++) {
      // Lifecycle-heavy rounds exceed the reserve, the others leave chatter to evict first
      const lifecycleShare = round % 3 === 0 ? 0.9 : round % 3 === 1 ? 0.3 : 0.05
      const n = 50 + Math.floor(rand() * 1200)
      const events = randomEvents(n, rand, lifecycleShare)
      const max = Math.max(1, Math.floor(n * (0.2 + rand() * 0.7)))
      const target = Math.max(0, max - Math.floor(rand() * (max / 5 + 1)))
      const expected = [...events], expectedOut: AgentEvent[] = []
      referenceTrim(expected, target, expectedOut)
      const actual = [...events], actualOut: AgentEvent[] = []
      const removed = trimKeepingLifecycle(actual, max, actualOut, target)
      assert.equal(removed, n - expected.length, `round ${round}: count removed`)
      assert.deepEqual(actual.map(e => e.payload.i), expected.map(e => e.payload.i), `round ${round}: events kept`)
      assert.deepEqual(actualOut.map(e => e.payload.i), expectedOut.map(e => e.payload.i), `round ${round}: events evicted, in order`)
    }
  })

  it('does nothing while the buffer is within its cap, whatever the target', () => {
    const buf = randomEvents(10, rng(1), 0.2)
    assert.equal(trimKeepingLifecycle(buf, 10, undefined, 5), 0)
    assert.equal(buf.length, 10)
  })

  it('appendBounded trims back to 90 % of the cap once it is exceeded, and counts exactly what it let go of', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const evicted = createEvictedTally()
    const gone: AgentEvent[] = []
    const lim = { perSession: 1000, sessions: 10, total: 100_000 }
    const msg = (i: number): AgentEvent => ({ time: i, type: 'message', payload: { agent: 'main', i } })
    for (let i = 0; i < 1000; i++) appendBounded(buffers, 's', msg(i), lim, evicted, (_s, evs) => gone.push(...evs))
    assert.equal(buffers.get('s')!.length, 1000, 'full, not over: nothing trimmed yet')
    appendBounded(buffers, 's', msg(1000), lim, evicted, (_s, evs) => gone.push(...evs))
    assert.equal(buffers.get('s')!.length, 900, 'one trim, down to 90 %')
    assert.equal(evicted.bySession.get('s'), 101)
    assert.deepEqual(gone.map(e => e.payload.i), Array.from({ length: 101 }, (_, i) => i), 'the oldest chatter, in order')
    for (let i = 1001; i < 1101; i++) appendBounded(buffers, 's', msg(i), lim, evicted)
    assert.equal(buffers.get('s')!.length, 1000, 'grows back to the cap before the next trim')
    assert.equal(evicted.bySession.get('s'), 101)
  })

  it('a small cap (under 10) is still trimmed to the cap itself', () => {
    const buffers = new Map<string, AgentEvent[]>()
    for (let i = 0; i < 20; i++) appendBounded(buffers, 's', { time: i, type: 'message', payload: {} }, { perSession: 5 })
    assert.deepEqual(buffers.get('s')!.map(e => e.time), [15, 16, 17, 18, 19])
  })
})

describe('index of the latest agent_activity per agent (#652)', () => {
  /** appendBounded as it was before #652 (find by scan, event-by-event trim), with the batched trim's target. */
  function referenceAppend(buf: AgentEvent[], event: AgentEvent, max: number, target: number) {
    const name = (e: AgentEvent) => (e.payload as { name?: unknown }).name
    const previous = event.type === 'agent_activity' ? buf.findIndex(e => e.type === 'agent_activity' && name(e) === name(event)) : -1
    if (previous >= 0) buf[previous] = event
    else buf.push(event)
    if (buf.length > max) referenceTrim(buf, target, [])
  }

  it('replaces the same activity as the scan did, through trims, for many agents', () => {
    const rand = rng(4242)
    const max = 300, target = 270
    const buffers = new Map<string, AgentEvent[]>()
    const expected: AgentEvent[] = []
    for (let i = 0; i < 20_000; i++) {
      const r = rand()
      const type: AgentEvent['type'] = r < 0.02 ? 'agent_spawn' : r < 0.5 ? 'agent_activity' : 'message'
      const e: AgentEvent = { time: i, type, payload: { name: `w${Math.floor(rand() * 60)}`, i } }
      appendBounded(buffers, 's', e, { perSession: max, sessions: 10, total: 1_000_000 })
      referenceAppend(expected, e, max, target)
    }
    assert.deepEqual(buffers.get('s')!.map(e => e.payload.i), expected.map(e => e.payload.i))
  })

  it('stays right when a context reading is replaced in between (#567 removes it from the buffer)', () => {
    const bd = { systemPrompt: 5000, userMessages: 1, toolResults: 0, reasoning: 0, subagentResults: 0 }
    const ctx = (tokens: number): AgentEvent => ({ time: 1, type: 'context_update', payload: { agent: 'main', tokens, tokenSource: 'estimated', breakdown: bd } })
    const act = (name: string, activity: string): AgentEvent => ({ time: 1, type: 'agent_activity', payload: { name, activity } })
    const buffers = new Map<string, AgentEvent[]>()
    for (const e of [act('a', 'working'), act('b', 'working'), ctx(5001), ctx(5002), act('a', 'idle'), act('b', 'done')]) appendBounded(buffers, 's', e)
    assert.deepEqual(buffers.get('s')!.map(e => `${e.type}:${e.payload.name ?? ''}:${e.payload.activity ?? e.payload.tokens}`),
      ['agent_activity:a:idle', 'agent_activity:b:done', 'context_update::5002'])
  })

  it('a buffer changed from outside is not trusted: the activity is still found', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const act = (name: string, activity: string): AgentEvent => ({ time: 1, type: 'agent_activity', payload: { name, activity } })
    appendBounded(buffers, 's', act('a', 'working'))
    buffers.get('s')!.unshift({ time: 0, type: 'message', payload: {} })
    appendBounded(buffers, 's', act('a', 'done'))
    assert.deepEqual(buffers.get('s')!.map(e => e.payload.activity ?? 'msg'), ['msg', 'done'])
  })
})

describe('cost of an append at the cap is O(1) amortised (#652)', () => {
  /** Element reads and writes the buffer receives (a Proxy counts them): independent of the machine's speed. */
  function costPerAppend(perSession: number, appends: number): number {
    const buffers = new Map<string, AgentEvent[]>()
    let touches = 0
    const counted = new Proxy([] as AgentEvent[], {
      get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) touches++; return Reflect.get(target, key, receiver) },
      set(target, key, value, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) touches++; return Reflect.set(target, key, value, receiver) },
    })
    buffers.set('s', counted)
    const lim = { perSession, sessions: 10, total: 10_000_000 }
    const agents = 200
    for (let i = 0; i < agents; i++) appendBounded(buffers, 's', { time: 0, type: 'agent_spawn', payload: { name: `w${i}` } }, lim)
    // Fill up to the cap first: only the steady state is measured
    for (let i = 0; buffers.get('s')!.length < perSession; i++) appendBounded(buffers, 's', { time: i, type: 'message', payload: { agent: 'main' } }, lim)
    touches = 0
    for (let i = 0; i < appends; i++) {
      const e: AgentEvent = i % 3 === 0
        ? { time: i, type: 'agent_activity', payload: { name: `w${i % agents}`, activity: i % 2 ? 'working' : 'idle' } }
        : { time: i, type: 'message', payload: { agent: 'main' } }
      appendBounded(buffers, 's', e, lim)
    }
    return touches / appends
  }

  it('does not grow with the size of the buffer', () => {
    const small = costPerAppend(1000, 3000)
    const large = costPerAppend(5000, 3000)
    // Before #652: a splice and a full findIndex per append, thousands of element accesses at a cap of 5000
    assert.ok(large < 40, `element accesses per append at a cap of 5000: ${large.toFixed(1)}`)
    assert.ok(large < small * 1.5 + 5, `cost at 5000 (${large.toFixed(1)}) vs at 1000 (${small.toFixed(1)})`)
  })
})
