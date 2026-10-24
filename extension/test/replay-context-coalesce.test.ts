/**
 * #567: in the relay's replay buffer, a context_update superseded AT THE SAME INSTANT by a later context_update of
 * the same agent is replaced, not kept beside it. Only when nothing a client shows can tell the difference: same
 * stream time (a review scrub reaches both or neither), only tool / message / context events in between (they
 * cannot change which agent a reading lands on), a later reading that sets everything the earlier one set
 * (tokens, breakdown, window). Lifecycle events are never replaced, and a replaced reading is not a loss.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { appendBounded, createEvictedTally } from '../src/relay-guards'
import { RELAY_REPLAY_LIFECYCLE_RESERVE } from '../src/constants'

const bd = (n: number) => ({ systemPrompt: 5000, userMessages: n, toolResults: 0, reasoning: 0, subagentResults: 0 })
const ctx = (agent: string, tokens: number, time = 1, extra: Record<string, unknown> = {}): AgentEvent =>
  ({ time, type: 'context_update', payload: { agent, tokens, tokenSource: 'estimated', breakdown: bd(tokens - 5000), ...extra } })
const ev = (type: AgentEvent['type'], time = 1, payload: Record<string, unknown> = { agent: 'main' }): AgentEvent => ({ time, type, payload })

function feed(events: AgentEvent[], limits = {}) {
  const buffers = new Map<string, AgentEvent[]>()
  const evicted = createEvictedTally()
  for (const e of events) appendBounded(buffers, 's', e, limits, evicted)
  return { buf: buffers.get('s')!, evicted }
}

describe('replay buffer: context_update superseded at the same instant (#567)', () => {
  it('replaces the earlier reading of the same agent and keeps the later one at its own place', () => {
    const a = ctx('main', 5003), b = ctx('main', 5013), c = ctx('main', 5013)
    const start = ev('tool_call_start'), end = ev('tool_call_end')
    const { buf, evicted } = feed([ev('agent_spawn', 0, { name: 'main' }), start, a, end, b, c])
    assert.deepEqual(buf.map(e => e.type), ['agent_spawn', 'tool_call_start', 'tool_call_end', 'context_update'])
    assert.equal(buf[3], c, 'the current context is the LAST reading')
    assert.equal(evicted.bySession.size, 0, 'a replaced reading is not counted as lost')
  })

  it('keeps readings of different instants (a review scrub shows each of them)', () => {
    const { buf } = feed([ctx('main', 5003, 1), ev('tool_call_end', 2), ctx('main', 5013, 2)])
    assert.equal(buf.filter(e => e.type === 'context_update').length, 2)
  })

  it('keeps readings of different agents', () => {
    const { buf } = feed([ctx('main', 5003), ctx('w1', 5003), ctx('main', 5013)])
    assert.deepEqual(buf.map(e => e.payload.agent), ['w1', 'main'])
  })

  for (const type of ['agent_spawn', 'subagent_dispatch', 'team_info', 'agent_complete', 'agent_idle', 'model_detected', 'context_compacted', 'subagent_return', 'agent_activity'] as const) {
    it(`keeps both readings when a ${type} comes in between (it may change where a reading lands)`, () => {
      const { buf } = feed([ctx('main', 5003), ev(type, 1, { name: 'main', agent: 'main' }), ctx('main', 5013)])
      assert.equal(buf.filter(e => e.type === 'context_update').length, 2)
    })
  }

  it('keeps the earlier reading when the later one does not set everything it set', () => {
    const cases: Array<[AgentEvent, AgentEvent, string]> = [
      [ctx('main', 5013), ctx('main', 5003), 'smaller figure: the window the larger one grew stays'],
      [ctx('main', 5003), { ...ctx('main', 5013), payload: { agent: 'main', tokens: 5013 } }, 'no breakdown'],
      [ctx('main', 5003), ctx('main', Number.NaN), 'no usable figure'],
      [ctx('main', 5003, 1, { tokensMax: 272000 }), ctx('main', 5013), 'the earlier one set a window the later one does not'],
      [ctx('main', 5003), { ...ctx('main', 5013), imported: true }, 'different provenance'],
    ]
    for (const [first, second, why] of cases) {
      const { buf } = feed([first, second])
      assert.equal(buf.length, 2, why)
    }
  })

  it('replaces a reading that set a window when the later one sets one too', () => {
    const { buf } = feed([ctx('main', 5003, 1, { tokensMax: 272000 }), ctx('main', 5013, 1, { tokensMax: 272000 })])
    assert.equal(buf.length, 1)
  })

  it('never replaces lifecycle events, and the lifecycle reserve still holds under a flood of readings', () => {
    const spawns = Array.from({ length: RELAY_REPLAY_LIFECYCLE_RESERVE }, (_, i) => ev('agent_spawn', 0, { name: `w${i}` }))
    const flood: AgentEvent[] = []
    for (let i = 0; i < 3000; i++) flood.push(ev('tool_call_end', i, { agent: 'main' }), ctx('main', 5000 + i, i), ctx('main', 5000 + i, i))
    const { buf, evicted } = feed([...spawns, ...flood], { perSession: 1000, sessions: 10, total: 100000 })
    // Per-session cap unchanged; a full buffer is trimmed in batches, back to 90 % of it (#652)
    assert.ok(buf.length <= 1000 && buf.length >= 900, `per-session cap unchanged: ${buf.length}`)
    assert.equal(buf.filter(e => e.type === 'agent_spawn').length, RELAY_REPLAY_LIFECYCLE_RESERVE, 'every spawn kept')
    // 9000 sent, 3000 replaced (one per instant), the rest of the overflow is a counted loss
    assert.equal(evicted.bySession.get('s'), 400 + 9000 - 3000 - buf.length)
  })

  it('a reading evicted by the cap is no longer a candidate: the next one is simply appended', () => {
    const first = ctx('main', 5003)
    const { buf } = feed([first, ev('tool_call_end'), ev('tool_call_end'), ctx('main', 5013)], { perSession: 2, sessions: 10, total: 100 })
    assert.deepEqual(buf.map(e => e.type), ['tool_call_end', 'context_update'])
  })
})
