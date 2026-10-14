import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseEventLoss, replayLostFor } from '../web/lib/event-loss'

// `event-loss` SSE message of the relay (#366): untrusted, parsed field by field.

test('parseEventLoss keeps only counts that are positive safe integers, and null for a message that is not one', () => {
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: { a: 3, b: -1, c: 'x', d: 1.5, e: 0 }, otherEvents: 4 }), { evicted: { a: 3 }, otherEvents: 4 })
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: {} }), { evicted: {}, otherEvents: 0 })
  assert.equal(parseEventLoss({ type: 'event-loss', evicted: 'x' }), null)
  assert.equal(parseEventLoss(null), null)
  assert.equal(parseEventLoss({ type: 'other', evicted: {} }), null)
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: {}, otherEvents: -2 }), { evicted: {}, otherEvents: 0 })
})

test('parseEventLoss ignores prototype keys and bounds the number of sessions', () => {
  const evicted = JSON.parse('{"__proto__": 5, "constructor": 2, "ok": 1}')
  const r = parseEventLoss({ type: 'event-loss', evicted })!
  assert.deepEqual(Object.keys(r.evicted), ['ok'])
  const many: Record<string, number> = {}
  for (let i = 0; i < 5000; i++) many['s' + i] = 1
  assert.ok(Object.keys(parseEventLoss({ type: 'event-loss', evicted: many })!.evicted).length <= 1000)
})

test('replayLostFor: a session reads its own count; a union view reads every session, a lower bound', () => {
  const loss = { evicted: { s1: 3, s2: 4 }, otherEvents: 10 }
  assert.equal(replayLostFor(loss, 's1', false), 3)
  assert.equal(replayLostFor(loss, 's3', false), 0, 'a session absent from the tally is not claimed as lossy')
  assert.equal(replayLostFor(loss, null, true), 17)
  assert.equal(replayLostFor(null, 's1', false), 0)
})
