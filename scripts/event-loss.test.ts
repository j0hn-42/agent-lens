import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  parseEventLoss, replayLostFor, replayLostForSession, acceptEventLoss, truncationBannerState, boundedCount, replayLostSentence,
  truncationDismissKey, readTruncationDismissals, writeTruncationDismissals, tabStorage, dismissTruncation, allViewSessionTotals,
} from '../web/lib/event-loss'

/** The sessionStorage key the dismissals live under (#567) */
const TRUNCATION_DISMISS_STORAGE_KEY = 'agent-lens:truncation-dismissed'
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

test('replayLostFor: All counts only the sessions it shows, and otherEvents only when it shows every one (#453)', () => {
  const loss = { evicted: { live: 3, old: 50, gone: 7 }, otherEvents: 9 }
  // showFinished off (the default) or a project scope: the view is a set of sessions
  assert.equal(replayLostFor(loss, ALL_SESSIONS_ID, null, new Set(['live'])), 3, 'old finished sessions out of the view are not counted')
  assert.equal(replayLostFor(loss, ALL_SESSIONS_ID, null, new Set(['live', 'old'])), 53)
  assert.equal(replayLostFor(loss, ALL_SESSIONS_ID, null, new Set(['unknown'])), 0, 'a shown session the tally does not name claims nothing')
  assert.equal(replayLostFor(loss, ALL_SESSIONS_ID, null, new Set()), 0, 'an empty view is never incomplete')
  assert.equal(replayLostFor(loss, null, null, new Set(['live'])), 3, 'no selection reads the same set')
  // Every session shown: the whole tally, otherEvents included (they may belong to a shown session)
  assert.equal(replayLostFor(loss, ALL_SESSIONS_ID, null, null), 69)
  assert.equal(replayLostFor(loss, ALL_SESSIONS_ID), 69)
  // The set says nothing for one session or a team
  assert.equal(replayLostFor(loss, 'old', null, new Set(['live'])), 50)
  assert.equal(replayLostFor(loss, 'team:x', new Set(['gone']), new Set(['live'])), 7)
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

// #567: a dismissal of the truncation banner lasts as long as the tab (sessionStorage), with the total it was dismissed at.

/** In-memory Storage double; `fail` makes every access throw like a blocked or full storage */
function fakeStorage(initial: Record<string, string> = {}, fail = false) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem(k: string) { if (fail) throw new Error('SecurityError'); return data.has(k) ? data.get(k)! : null },
    setItem(k: string, v: string) { if (fail) throw new Error('QuotaExceededError'); data.set(k, v) },
  }
}

test('truncationDismissKey: one key for the All view (null, empty or the All pseudo id), one per selection otherwise', () => {
  assert.equal(truncationDismissKey(null), truncationDismissKey(ALL_SESSIONS_ID))
  assert.equal(truncationDismissKey(undefined), truncationDismissKey(''))
  assert.equal(truncationDismissKey(''), truncationDismissKey(ALL_SESSIONS_ID))
  assert.notEqual(truncationDismissKey('s1'), truncationDismissKey(ALL_SESSIONS_ID))
  assert.notEqual(truncationDismissKey('s1'), truncationDismissKey('s2'))
  assert.notEqual(truncationDismissKey('all'), truncationDismissKey(ALL_SESSIONS_ID), 'a session named like the view is not the view')
})

test('dismissals round-trip through the tab storage, keyed by selection, with the total dismissed at', () => {
  const store = fakeStorage()
  const map = new Map([[truncationDismissKey(ALL_SESSIONS_ID), 6371], [truncationDismissKey('s1'), 40]])
  assert.equal(writeTruncationDismissals(store, map), true)
  assert.ok(store.data.has(TRUNCATION_DISMISS_STORAGE_KEY))
  assert.deepEqual([...readTruncationDismissals(store)], [...map])
  // The dismissal holds at the same total and lets the banner back when the total grows (truncationBannerState)
  const read = readTruncationDismissals(store)
  assert.equal(truncationBannerState(createStats(), 40, read.get(truncationDismissKey('s1'))).show, false)
  assert.equal(truncationBannerState(createStats(), 41, read.get(truncationDismissKey('s1'))).show, true)
})

test('an unavailable storage (it throws, or there is none) never throws: nothing is remembered, nothing breaks', () => {
  const broken = fakeStorage({}, true)
  assert.deepEqual([...readTruncationDismissals(broken)], [])
  assert.equal(writeTruncationDismissals(broken, new Map([['x', 1]])), false)
  assert.deepEqual([...readTruncationDismissals(null)], [])
  assert.equal(writeTruncationDismissals(null, new Map([['x', 1]])), false)
})

test('tabStorage returns null when reading window.sessionStorage itself throws (blocked site data)', () => {
  const g = globalThis as Record<string, unknown>
  const had = Object.getOwnPropertyDescriptor(g, 'window')
  const store = fakeStorage()
  try {
    if (!had) assert.equal(tabStorage(), null, 'no window (server render): no storage')
    Object.defineProperty(g, 'window', { configurable: true, value: { sessionStorage: store } })
    assert.equal(tabStorage(), store, 'the tab storage when it can be read')
    Object.defineProperty(g, 'window', { configurable: true, value: { get sessionStorage() { throw new Error('SecurityError') } } })
    assert.equal(tabStorage(), null)
  } finally {
    if (had) Object.defineProperty(g, 'window', had)
    else delete g.window
  }
})

test('the stored value is untrusted: junk, prototype keys, bad counts and oversized maps are dropped', () => {
  for (const raw of ['not json', '[1,2]', 'null', '"x"', '42']) {
    assert.deepEqual([...readTruncationDismissals(fakeStorage({ [TRUNCATION_DISMISS_STORAGE_KEY]: raw }))], [], raw)
  }
  const raw = JSON.stringify({ a: 3, b: -1, c: 'x', d: 1.5, e: 0, [`k${'x'.repeat(400)}`]: 2 }).replace('{', '{"__proto__": 5,')
  assert.deepEqual([...readTruncationDismissals(fakeStorage({ [TRUNCATION_DISMISS_STORAGE_KEY]: raw }))], [['a', 3], ['e', 0]])
  const many: Record<string, number> = {}
  for (let i = 0; i < 1000; i++) many['s' + i] = i
  assert.ok(readTruncationDismissals(fakeStorage({ [TRUNCATION_DISMISS_STORAGE_KEY]: JSON.stringify(many) })).size <= 100)
  // Writing keeps the latest entries when there are too many
  const store = fakeStorage()
  writeTruncationDismissals(store, new Map(Object.entries(many)))
  const kept = readTruncationDismissals(store)
  assert.ok(kept.size <= 100)
  assert.equal(kept.get('s999'), 999, 'the newest dismissal is kept')
})

test('allViewSessionTotals: what the All view counted for each session (normalizer counters, plus the replay loss of the sessions All shows)', () => {
  const stats = new Map([['s1', { ...createStats(), ignoredEvents: 2, clampedFields: 9 }], ['s2', createStats()]])
  const loss = { evicted: { s1: 10, s3: 7, hidden: 50 }, otherEvents: 4 }
  assert.deepEqual([...allViewSessionTotals(stats, loss, new Set(['s1', 's2', 's3']))].sort(), [['s1', 12], ['s3', 7]])
  // All shows every session (null): every named session's replay loss; otherEvents names none
  assert.deepEqual([...allViewSessionTotals(stats, loss, null)].sort(), [['hidden', 50], ['s1', 12], ['s3', 7]])
  assert.deepEqual([...allViewSessionTotals(new Map(), null, null)], [])
})

test('dismissTruncation: stores the total of the view; dismissing All also covers each session it counted, never lowering a stored total', () => {
  const all = truncationDismissKey(ALL_SESSIONS_ID)
  const s1 = truncationDismissKey('s1')
  const s2 = truncationDismissKey('s2')
  const prev = new Map([[s2, 99]])
  const next = dismissTruncation(prev, all, 19, new Map([['s1', 12], ['s2', 7]]))
  assert.equal(prev.size, 1, 'the previous map is not mutated')
  assert.equal(next.get(all), 19)
  assert.equal(next.get(s1), 12, 'switching from All to s1 at the same total keeps the banner closed')
  assert.equal(next.get(s2), 99, 'a higher stored total is kept')
  assert.equal(truncationBannerState({ ...createStats(), ignoredEvents: 2 }, 10, next.get(s1)).show, false)
  assert.equal(truncationBannerState({ ...createStats(), ignoredEvents: 2 }, 11, next.get(s1)).show, true, 'more lost in s1: back')
  // A session dismissal stays a session dismissal
  const one = dismissTruncation(new Map(), s1, 12, new Map([['s2', 7]]))
  assert.deepEqual([...one], [[s1, 12]], 'covered totals only apply to the All view')
})
