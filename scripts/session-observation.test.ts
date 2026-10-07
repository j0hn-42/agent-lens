import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SessionInfo } from '../web/lib/bridge-types'
import {
  ObservedSessionsTracker, MAX_OBSERVED_SESSIONS, deriveSessionObservation, SESSION_NOT_OBSERVED_TEXT,
} from '../web/lib/session-model'
import { buildSessionRows, filterActiveSessions } from '../web/lib/session-tree'

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
  assert.deepEqual(filterActiveSessions(sessions, null).map(s => s.id), ['seen', 'ghost'], 'without the predicate: legacy behaviour')
})

test('buildSessionRows: unobserved sessions come after the proven active ones, before completed', () => {
  const sessions = [session('done', 'completed', 9), session('ghost', 'active', 8), session('seen', 'active', 1)]
  const rows = buildSessionRows(sessions, [], new Map(), s => s.id === 'seen')
  assert.deepEqual(rows.filter(r => r.kind === 'session').map(r => r.id), ['seen', 'ghost', 'done'])
})
