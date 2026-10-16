import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseEventLoss, replayLostFor, replayLostForSession, acceptEventLoss, truncationBannerState, boundedCount, replayLostSentence } from '../web/lib/event-loss'
import { createStats } from '../web/lib/event-normalize'
import { ALL_SESSIONS_ID } from '../web/lib/bridge-types'

// `event-loss` SSE message of the relay (#366): untrusted, parsed field by field.

test('parseEventLoss keeps only counts that are positive safe integers, and null for a message that is not one', () => {
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: { a: 3, b: -1, c: 'x', d: 1.5, e: 0 }, otherEvents: 4 }), { evicted: { a: 3 }, otherEvents: 4 })
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: {} }), { evicted: {}, otherEvents: 0 })
  assert.equal(parseEventLoss({ type: 'event-loss', evicted: 'x' }), null)
  assert.equal(parseEventLoss(null), null)
  assert.equal(parseEventLoss({ type: 'other', evicted: {} }), null)
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: {}, otherEvents: -2 }), { evicted: {}, otherEvents: 0 })
})

test('parseEventLoss ignores prototype keys, long keys, and bounds the entries it reads', () => {
  const evicted = JSON.parse('{"__proto__": 5, "constructor": 2, "ok": 1}')
  const r = parseEventLoss({ type: 'event-loss', evicted })!
  assert.deepEqual(Object.keys(r.evicted), ['ok'])
  const many: Record<string, number> = {}
  for (let i = 0; i < 5000; i++) many['s' + i] = 1
  assert.ok(Object.keys(parseEventLoss({ type: 'event-loss', evicted: many })!.evicted).length <= 1000)
  const long = { ['x'.repeat(257)]: 4, [`y${'x'.repeat(255)}`]: 5 }
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: long })!.evicted, { ['y' + 'x'.repeat(255)]: 5 }, 'a key over 256 characters is no session id')
})

test('parseEventLoss does not walk past its bound: junk entries count toward it', () => {
  let visited = 0
  const evicted = new Proxy({} as Record<string, unknown>, {
    ownKeys: () => Array.from({ length: 100_000 }, (_, i) => 'k' + i),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: 'junk' }),
    get: () => { visited++; return 'junk' },
  })
  parseEventLoss({ type: 'event-loss', evicted })
  assert.ok(visited <= 5000, `read ${visited} entries`)
})

test('replayLostFor: a session reads its own count only', () => {
  const loss = { evicted: { s1: 3, s2: 4 }, otherEvents: 10 }
  assert.equal(replayLostFor(loss, 's1'), 3)
  assert.equal(replayLostFor(loss, 's3'), 0, 'a session absent from the tally is not claimed as lossy')
  assert.equal(replayLostFor(null, 's1'), 0)
})

test('replayLostFor: All and no selection read the whole tally, a team only its own sessions', () => {
  const loss = { evicted: { a: 3, b: 4, c: 5 }, otherEvents: 9 }
  assert.equal(replayLostFor(loss, ALL_SESSIONS_ID), 21)
  assert.equal(replayLostFor(loss, null), 21)
  assert.equal(replayLostFor(loss, 'team:x', new Set(['a', 'b'])), 7, 'sessions of the team, no otherEvents')
  assert.equal(replayLostFor(loss, 'team:x', new Set(['z'])), 0)
  assert.equal(replayLostFor(loss, 'team:x', null), 0, 'membership unknown: nothing is claimed')
  assert.equal(replayLostFor(loss, 'team:x', new Set(['__proto__', 'toString'])), 0)
})

test('acceptEventLoss keeps the figure of the first connection of a graph and ignores later ones', () => {
  const first = { evicted: { a: 3 }, otherEvents: 0 }
  const later = { evicted: { a: 50 }, otherEvents: 0 }
  assert.equal(acceptEventLoss(1, null, first), first)
  assert.equal(acceptEventLoss(2, first, later), first, 'a reconnection that kept the graph says nothing about it')
  assert.equal(acceptEventLoss(2, null, later), null)
  assert.equal(acceptEventLoss(0, null, first), first, 'the status effect may not have run yet: still the first connection')
  assert.equal(acceptEventLoss(1, first, null), first, 'a malformed message never clears a figure')
})

test('truncationBannerState: shown while something was lost, back when more is lost, replay loss included', () => {
  const none = createStats()
  const cut = { ...none, ignoredEvents: 2 }
  assert.deepEqual(truncationBannerState(none, 0, undefined), { show: false, total: 0 })
  assert.deepEqual(truncationBannerState(cut, 0, undefined), { show: true, total: 2 })
  assert.deepEqual(truncationBannerState(none, 7, undefined), { show: true, total: 7 })
  assert.equal(truncationBannerState(cut, 5, undefined).total, 7)
  assert.equal(truncationBannerState(cut, 5, 7).show, false, 'dismissed at the total shown')
  assert.equal(truncationBannerState(cut, 6, 7).show, true, 'the replay loss grew: it comes back')
  assert.equal(truncationBannerState({ ...cut, ignoredEvents: 3 }, 5, 7).show, true, 'the normalizer dropped more: it comes back')
  assert.equal(truncationBannerState(cut, 0, 7).show, false, 'the replay loss went down to 0 but the dismissal holds')
  assert.equal(truncationBannerState(none, 0, 7).show, false, 'nothing to show at all')
  assert.equal(truncationBannerState({ ...none, clampedFields: 9, duplicateEvents: 9 }, 0, undefined).show, false, 'benign counters never trigger it')
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

test('replayLostForSession: an agent card reads its own session only, never the total of a view (#366)', () => {
  const loss = { evicted: { s1: 3, s2: 4 }, otherEvents: 10 }
  assert.equal(replayLostForSession(loss, 's1'), 3)
  assert.equal(replayLostForSession(loss, 's3'), 0, 'a session absent from the tally is not claimed as lossy')
  assert.equal(replayLostForSession(loss, undefined), 0, 'no session: nothing is claimed, unlike replayLostFor with no selection')
  assert.equal(replayLostForSession(loss, ''), 0)
  assert.equal(replayLostForSession(loss, ALL_SESSIONS_ID), 0, 'the All pseudo selection is no session')
  assert.equal(replayLostForSession(loss, '__proto__'), 0)
  assert.equal(replayLostForSession(null, 's1'), 0)
})
