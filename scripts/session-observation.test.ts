import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SessionInfo } from '../web/lib/bridge-types'
import {
  ObservedSessionsTracker, MAX_OBSERVED_SESSIONS, deriveSessionObservation, SESSION_NOT_OBSERVED_TEXT, observedSessions,
} from '../web/lib/session-model'
import { buildSessionRows, filterActiveSessions } from '../web/lib/session-tree'
import { sessionStatusKind, SESSION_STATUS_TEXT, buildAnnouncement, connectionDisplay } from '../web/lib/chrome-utils'
import { isSessionObserved, countUnobservedSessions } from '../web/lib/session-model'

const session = (id: string, status: SessionInfo['status'], lastActivityTime = 0): SessionInfo =>
  ({ id, label: id, status, startTime: 0, lastActivityTime })

test('the visible status text is the documented one', () => {
  assert.equal(SESSION_NOT_OBSERVED_TEXT, 'listed - activity not observed')
})

test('tracker: marks sessions once, notifies only on a new session, ignores junk ids', () => {
  const t = new ObservedSessionsTracker()
  let calls = 0
  t.subscribe(() => calls++)
  assert.equal(t.has('s1'), false)
  assert.equal(t.mark('s1'), true)
  assert.equal(t.mark('s1'), false)
  assert.equal(t.mark(undefined), false)
  assert.equal(t.mark(''), false)
  assert.equal(t.mark(42), false)
  assert.equal(calls, 1)
  assert.equal(t.has('s1'), true)
  assert.equal(t.getVersion(), 1)
})

test('tracker: bounded, forgets the oldest sessions', () => {
  const t = new ObservedSessionsTracker()
  for (let i = 0; i <= MAX_OBSERVED_SESSIONS; i++) t.mark(`s${i}`)
  assert.equal(t.has('s0'), false)
  assert.equal(t.has(`s${MAX_OBSERVED_SESSIONS}`), true)
})

test('tracker: unsubscribe and clear', () => {
  const t = new ObservedSessionsTracker()
  let calls = 0
  const off = t.subscribe(() => calls++)
  t.mark('a'); off(); t.mark('b')
  assert.equal(calls, 1)
  t.clear()
  assert.equal(t.has('a'), false)
})

test('deriveSessionObservation: active, never heard from, no live flag is not observed', () => {
  const none = () => false
  assert.equal(deriveSessionObservation(session('s', 'active'), none), 'not-observed')
  assert.equal(deriveSessionObservation(session('s', 'active'), id => id === 's'), 'observed', 'an event was received')
  assert.equal(deriveSessionObservation(session('s', 'active'), none, true), 'observed', 'live hook flag')
  assert.equal(deriveSessionObservation(session('s', 'completed'), none), 'observed', 'a completed session is read from disk, not guessed')
})

test('filterActiveSessions: an unobserved session is not counted as active (but a selected one stays)', () => {
  const sessions = [session('seen', 'active'), session('ghost', 'active'), session('done', 'completed')]
  const observed = (s: SessionInfo) => s.id === 'seen'
  assert.deepEqual(filterActiveSessions(sessions, null, observed).map(s => s.id), ['seen'])
  assert.deepEqual(filterActiveSessions(sessions, 'ghost', observed).map(s => s.id), ['seen', 'ghost'])
  assert.deepEqual(filterActiveSessions(sessions, null).map(s => s.id), [], 'default predicate = app-wide tracker: nothing observed yet')
  observedSessions.mark('seen')
  assert.deepEqual(filterActiveSessions(sessions, null).map(s => s.id), ['seen'], 'the default excludes the unobserved session')
  assert.deepEqual(filterActiveSessions(sessions, 'ghost').map(s => s.id), ['seen', 'ghost'], 'the selected one stays')
  observedSessions.clear()
})

test('buildSessionRows: unobserved sessions come after the proven active ones, before completed', () => {
  const sessions = [session('done', 'completed', 9), session('ghost', 'active', 8), session('seen', 'active', 1)]
  const rows = buildSessionRows(sessions, [], new Map(), undefined, undefined, s => s.id === 'seen')
  assert.deepEqual(rows.filter(r => r.kind === 'session').map(r => r.id), ['seen', 'ghost', 'done'])
})

// ─── Review fixes (#52) ──────────────────────────────────────────────────────

test('tracker: bounded at exactly MAX_OBSERVED_SESSIONS (one below and at the limit keep everything, one above drops the oldest)', () => {
  const below = new ObservedSessionsTracker()
  for (let i = 0; i < MAX_OBSERVED_SESSIONS - 1; i++) below.mark(`s${i}`)
  assert.equal(below.has('s0'), true, 'one below the limit')
  const at = new ObservedSessionsTracker()
  for (let i = 0; i < MAX_OBSERVED_SESSIONS; i++) at.mark(`s${i}`)
  assert.equal(at.has('s0'), true, 'exactly at the limit nothing is forgotten')
  assert.equal(at.has(`s${MAX_OBSERVED_SESSIONS - 1}`), true)
  at.mark('overflow')
  assert.equal(at.has('s0'), false, 'one above the limit the oldest is forgotten')
  assert.equal(at.has('s1'), true)
})

test('tracker: a session that keeps receiving events is not the one evicted', () => {
  const t = new ObservedSessionsTracker()
  for (let i = 0; i < MAX_OBSERVED_SESSIONS; i++) t.mark(`s${i}`)
  const version = t.getVersion()
  assert.equal(t.mark('s0'), false, 'already known: not a new session')
  assert.equal(t.getVersion(), version, 'and no notification')
  t.mark('newcomer')
  assert.equal(t.has('s0'), true, 'the busy session survives')
  assert.equal(t.has('s1'), false, 'the quietest one is dropped instead')
})

test('isSessionObserved / countUnobservedSessions follow the tracker by default and honour overrides', () => {
  observedSessions.clear()
  const list = [session('seen', 'active'), session('ghost', 'active'), session('done', 'completed')]
  assert.equal(countUnobservedSessions(list), 2, 'nothing observed: both active sessions are unknown (completed is a fact)')
  observedSessions.mark('seen')
  assert.equal(countUnobservedSessions(list), 1)
  assert.equal(isSessionObserved(list[1]), false)
  assert.equal(isSessionObserved(list[1], true), true, 'live flag')
  assert.equal(countUnobservedSessions(list, id => id === 'ghost'), 0, 'live flags are honoured')
  assert.equal(countUnobservedSessions(list, () => false, () => true), 0, 'custom observation')
  observedSessions.clear()
})

test('sessionStatusKind: an active session with no event reads "unobserved", never active (tabs / list consumer)', () => {
  observedSessions.clear()
  const ghost = { id: 'ghost', status: 'active' as const }
  assert.equal(sessionStatusKind(ghost, false, false), 'unobserved')
  assert.equal(sessionStatusKind(ghost, false, true), 'unobserved', 'selected or not')
  assert.equal(SESSION_STATUS_TEXT.unobserved, SESSION_NOT_OBSERVED_TEXT)
  assert.equal(SESSION_STATUS_TEXT.unobserved.includes('active,'), false)
  observedSessions.mark('ghost')
  assert.equal(sessionStatusKind(ghost, false, false), 'active', 'an event was received')
  observedSessions.clear()
  assert.equal(sessionStatusKind(ghost, false, false, id => id === 'ghost'), 'active', 'explicit predicate')
  assert.equal(sessionStatusKind(ghost, true, true), 'active', 'live flag (selected)')
  assert.equal(sessionStatusKind(ghost, true, false), 'new-activity', 'live flag (background)')
  assert.equal(sessionStatusKind({ id: 'old', status: 'completed' }, false, false), 'completed', 'completed is read from disk')
})

test('buildAnnouncement: the number of unobserved sessions is announced, and only when there are some', () => {
  const connection = connectionDisplay('watching', false)
  const base = { connection, sessionLabel: null, isReviewing: false, isEmpty: false }
  assert.equal(buildAnnouncement(base), 'Connection: live. Live mode')
  assert.equal(buildAnnouncement({ ...base, unobservedSessions: 0 }), 'Connection: live. Live mode')
  assert.equal(buildAnnouncement({ ...base, unobservedSessions: 1 }), 'Connection: live. Live mode. 1 session listed, activity not observed')
  assert.equal(buildAnnouncement({ ...base, unobservedSessions: 3 }), 'Connection: live. Live mode. 3 sessions listed, activity not observed')
})
