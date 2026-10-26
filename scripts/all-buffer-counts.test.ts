// Per-session counters of the 'All' buffer (#613): a union view that shows only some sessions counts only their events
// dropped after its mark, exactly, whatever the other sessions lost.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { pushBounded } from '../web/lib/bounded-buffer'
import { createAllBufferCounts, countAllArrival, countAllDrops, unionMark, unionDroppedSince } from '../web/lib/all-buffer-counts'
import type { SimulationEvent } from '../web/lib/agent-types'

const sev = (sessionId: string | undefined, time: number): SimulationEvent =>
  ({ time, type: 'agent_activity', payload: { name: 'main' }, sessionId } as SimulationEvent)

function feed(sessions: Array<string | undefined>, cap: number) {
  const buf: SimulationEvent[] = []
  const c = createAllBufferCounts()
  let base = 0
  const push = (sid: string | undefined, t: number) => {
    countAllArrival(c, sid)
    base += pushBounded(buf, sev(sid, t), cap, Number.MAX_SAFE_INTEGER, 0, d => countAllDrops(c, d))
  }
  sessions.forEach((sid, i) => push(sid, i))
  return { buf, c, push, base: () => base }
}

test('a view of one session out of two counts only that session, after its mark', () => {
  // a, b, a, b ... 6 events, cap 10: nothing dropped yet; the view of 'a' had them all
  const f = feed(['a', 'b', 'a', 'b', 'a', 'b'], 10)
  const mark = unionMark(f.c, [])
  // 14 more events, 'b' only except one 'a' at position 6: 20 in all, cap 10, positions 0..9 dropped
  f.push('a', 6)
  for (let t = 7; t < 20; t++) f.push('b', t)
  assert.equal(f.base(), 10)
  const onlyA = (sid: string | undefined) => sid === 'a'
  // dropped 'a' events: positions 0, 2, 4 (before the mark) and 6 (after): 1
  assert.equal(unionDroppedSince(f.c, onlyA, mark), 1)
  assert.equal(unionDroppedSince(f.c, onlyA), 4, 'without a mark: every dropped event of the view')
  // every session: the 10 dropped minus the 6 the mark had
  assert.equal(unionDroppedSince(f.c, () => true, mark), 4)
})

test('events still queued for the view sit after its cursor, events without a session have their own count', () => {
  const f = feed(['a', undefined, 'a'], 100)
  // the view had the first event only: the two others are still queued
  const mark = unionMark(f.c, f.buf.slice(1))
  for (let t = 3; t < 200; t++) f.push('b', t)
  // cap 100 over 200 events: positions 0..99 dropped, among them the 3 first
  assert.equal(unionDroppedSince(f.c, sid => sid !== 'b', mark), 2, 'the queued unattributed event and the second a')
})
