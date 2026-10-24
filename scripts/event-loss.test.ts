import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  parseEventLoss, replayLostFor, replayLostForSession, acceptEventLoss, truncationBannerState, boundedCount,
  truncationDismissKey, readTruncationDismissals, writeTruncationDismissals, tabStorage, dismissTruncation, allViewSessionTotals,
  viewNormalizationStats,
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

test('parseEventLoss reads the gap of a reconnection like the counts (#366)', () => {
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: {}, gap: { a: 2, b: -1, c: 'x' } }), { evicted: {}, otherEvents: 0, gap: { a: 2 } })
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: { a: 1 } }), { evicted: { a: 1 }, otherEvents: 0 }, 'no gap field when none was sent')
  assert.deepEqual(parseEventLoss({ type: 'event-loss', evicted: {}, gap: 'x' }), { evicted: {}, otherEvents: 0 })
})

test('acceptEventLoss adds the gap of a reconnection (events the cut link lost) to the figure the graph keeps (#366)', () => {
  const first = { evicted: { a: 3 }, otherEvents: 2 }
  // The relay's totals of a later connection are still ignored; only the gap, counted for THIS client, is added
  assert.deepEqual(acceptEventLoss(2, first, { evicted: { a: 50 }, otherEvents: 9, gap: { a: 4, b: 1 } }), { evicted: { a: 7, b: 1 }, otherEvents: 2 })
  assert.deepEqual(acceptEventLoss(3, null, { evicted: { a: 50 }, otherEvents: 0, gap: { c: 5 } }), { evicted: { c: 5 }, otherEvents: 0 }, 'a first connection without loss, then a gap')
  assert.equal(acceptEventLoss(2, first, { evicted: { a: 50 }, otherEvents: 0, gap: {} }), first, 'an empty gap changes nothing')
  // A first connection never carries a gap (no since); if one came, it is not added on top of totals that already cover it
  assert.deepEqual(acceptEventLoss(1, null, { evicted: { a: 3 }, otherEvents: 0, gap: { a: 3 } }), { evicted: { a: 3 }, otherEvents: 0 })
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
  // #569 review: a total below the one dismissed at no longer describes what was dismissed (relay restarted, graph
  // reloaded, another set of sessions shown): the banner shows again with the figure that is true now
  assert.equal(truncationBannerState(cut, 0, 7).show, true, 'the replay loss went down to 0: the 2 events ignored are shown again')
  assert.equal(truncationBannerState(none, 0, 7).show, false, 'nothing to show at all')
  assert.equal(truncationBannerState({ ...none, clampedFields: 9, duplicateEvents: 9 }, 0, undefined).show, false, 'benign counters never trigger it')
})

test('truncationBannerState, relay: a lower total brings a dismissed notice back, the rule of #569 (#605 review)', () => {
  const none = createStats()
  // Relay (#569): a total below the one dismissed at means the relay restarted or the graph was reloaded: a new loss
  assert.equal(truncationBannerState(none, 7, 10, 'relay').show, true, 'relay restarted: a new loss')
  assert.equal(truncationBannerState(none, 10, 10, 'relay').show, false, 'same total: still dismissed')
  assert.equal(truncationBannerState(none, 11, 10, 'relay').show, true, 'more lost: it comes back')
  assert.equal(truncationBannerState(none, 7, 10).show, true, 'the relay rule is the default')
})

test('truncationBannerState, VS Code extension: only a total ABOVE the one dismissed at brings the notice back, a lower one never does (#605 review round 4)', () => {
  const none = createStats()
  // The extension lowers its figure while the page is open (a history read again reaches it): part of the loss already dismissed
  assert.equal(truncationBannerState(none, 7, 10, 'extension').show, false, 'lower: part of the loss already dismissed')
  assert.equal(truncationBannerState(none, 1, 10, 'extension').show, false, 'transiently much lower (a view rebuilt): still closed')
  assert.equal(truncationBannerState(none, 10, 10, 'extension').show, false, 'same total: still dismissed')
  assert.equal(truncationBannerState(none, 11, 10, 'extension').show, true, 'above the dismissed total: a new loss, back')
  assert.equal(truncationBannerState(none, 7, undefined, 'extension').show, true, 'never dismissed: shown')
  assert.equal(truncationBannerState(none, 0, 10, 'extension').show, false, 'nothing lost: nothing to show')
  // Stateless: the lowest total seen is never kept, so 7 then 9 (both under 10) stays closed. The honest limit, said in the
  // docs: a new loss smaller than the gap between the dismissed total and the lowest total seen is not signalled by the
  // notice (the mark on the Sessions button stays).
  assert.equal(truncationBannerState(none, 9, 10, 'extension').show, false, '7 then 9, under 10: not signalled by the notice')
})

test('boundedCount: a total over an incomplete graph reads "at least", a zero is never a clean zero (#366)', () => {
  assert.equal(boundedCount(3, 0, 'conflict'), '3 conflicts')
  assert.equal(boundedCount(1, 0, 'tool error'), '1 tool error')
  assert.equal(boundedCount(0, 0, 'tool error'), '0 tool errors')
  assert.equal(boundedCount(3, 5, 'conflict'), 'at least 3 conflicts')
  assert.equal(boundedCount(1, 5, 'tool error'), 'at least 1 tool error')
  assert.equal(boundedCount(0, 5, 'tool error'), 'no tool error observed (incomplete)')
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
  // s2's own view still counts 99 (a replay loss All does not show): its earlier dismissal at 99 still holds
  const next = dismissTruncation(prev, all, 19, new Map([['s1', 12], ['s2', 7]]), new Map([['s1', 12], ['s2', 99]]))
  assert.equal(prev.size, 1, 'the previous map is not mutated')
  assert.equal(next.get(all), 19)
  assert.equal(next.get(s1), 12, 'switching from All to s1 at the same total keeps the banner closed')
  assert.equal(next.get(s2), 99, 'a higher stored total that the session view still counts is kept')
  // #569 review: a higher stored total the session no longer counts is stale (relay restarted): replaced, not kept
  const stale = dismissTruncation(prev, all, 19, new Map([['s1', 12], ['s2', 7]]), new Map([['s1', 12], ['s2', 7]]))
  assert.equal(stale.get(s2), 7, 'stale higher total replaced by what All counted')
  assert.equal(truncationBannerState({ ...createStats(), ignoredEvents: 7 }, 0, stale.get(s2)).show, false, 'so s2 opens closed after the All dismissal')
  assert.equal(truncationBannerState({ ...createStats(), ignoredEvents: 2 }, 10, next.get(s1)).show, false)
  assert.equal(truncationBannerState({ ...createStats(), ignoredEvents: 2 }, 11, next.get(s1)).show, true, 'more lost in s1: back')
  // A session dismissal stays a session dismissal
  const one = dismissTruncation(new Map(), s1, 12, new Map([['s2', 7]]))
  assert.deepEqual([...one], [[s1, 12]], 'covered totals only apply to the All view')
})

test('truncationBannerState: a total LOWER than the one dismissed at is a new loss (relay restarted, graph reloaded), so the banner shows (#569 review)', () => {
  const stats = { ...createStats(), ignoredEvents: 3, droppedByCap: 2 }
  assert.equal(truncationBannerState(stats, 0, 5).show, false, 'same total: still dismissed')
  assert.equal(truncationBannerState(stats, 0, 100).show, true, 'normalizer counters only, lower than dismissed at')
  assert.equal(truncationBannerState(createStats(), 40, 6371).show, true, 'replay loss only, lower than dismissed at')
  assert.equal(truncationBannerState(createStats(), 0, 100).show, false, 'nothing lost now: nothing to show')
})

test('allViewSessionTotals: the normalizer counters of a session All does not show are not counted for it either', () => {
  const stats = new Map([['s1', { ...createStats(), ignoredEvents: 2 }], ['hidden', { ...createStats(), droppedByCap: 5 }]])
  assert.deepEqual([...allViewSessionTotals(stats, null, new Set(['s1']))], [['s1', 2]])
  assert.deepEqual([...allViewSessionTotals(stats, null, null)].sort(), [['hidden', 5], ['s1', 2]])
})

test('viewNormalizationStats: the counters of the sessions of the view only, the scope of the replay loss', () => {
  const stats = new Map([
    ['s1', { ...createStats(), ignoredEvents: 2, clampedFields: 1 }],
    ['s2', { ...createStats(), droppedByCap: 3 }],
    ['hidden', { ...createStats(), ignoredEvents: 40 }],
  ])
  // One session: its own counters, a fresh zero for a session with none
  assert.equal(viewNormalizationStats(stats, 's1', null).ignoredEvents, 2)
  assert.deepEqual(viewNormalizationStats(stats, 'nope', null), createStats())
  // All (or a team) with the sessions it counts: the others are left out
  const all = viewNormalizationStats(stats, ALL_SESSIONS_ID, new Set(['s1', 's2']))
  assert.deepEqual([all.ignoredEvents, all.droppedByCap, all.clampedFields], [2, 3, 1])
  const team = viewNormalizationStats(stats, 'team:T', new Set(['s2']))
  assert.deepEqual([team.ignoredEvents, team.droppedByCap], [0, 3])
  // All showing every session (null): every session
  assert.equal(viewNormalizationStats(stats, ALL_SESSIONS_ID, null).ignoredEvents, 42)
  assert.equal(viewNormalizationStats(stats, null, null).ignoredEvents, 42)
})
