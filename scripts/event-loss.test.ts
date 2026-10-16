import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseEventLoss, replayLostFor, boundedCount, replayLostSentence } from '../web/lib/event-loss'

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

test('boundedCount: a total over an incomplete graph reads "at least", a zero is never a clean zero (#366)', () => {
  assert.equal(boundedCount(3, 0, 'conflict'), '3 conflicts')
  assert.equal(boundedCount(1, 0, 'tool error'), '1 tool error')
  assert.equal(boundedCount(0, 0, 'tool error'), '0 tool errors')
  assert.equal(boundedCount(3, 5, 'conflict'), 'at least 3 conflicts')
  assert.equal(boundedCount(1, 5, 'tool error'), 'at least 1 tool error')
  assert.equal(boundedCount(0, 5, 'tool error'), 'no tool error observed (incomplete)')
})

test('replayLostSentence names what is missing without claiming an exact figure', () => {
  assert.equal(replayLostSentence(0), '')
  assert.equal(replayLostSentence(1), 'at least 1 earlier event was not replayed by the relay')
  assert.equal(replayLostSentence(7), 'at least 7 earlier events were not replayed by the relay')
})
