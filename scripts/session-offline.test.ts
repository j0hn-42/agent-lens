// #367: with the relay offline, a session is never shown as "active" and its duration stops growing.
import './all-locales' // #662: the tables are loaded on demand, every one is loaded before the tests
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SessionInfo } from '../web/lib/bridge-types'
import { sessionStatusKind, SESSION_STATUS_TEXT } from '../web/lib/chrome-utils'
import { SESSION_OFFLINE_TEXT } from '../web/lib/session-model'
import { sessionTimeCell } from '../web/lib/session-columns'

const T0 = 1_700_000_000_000
const active: SessionInfo = { id: 's1', label: 's1', status: 'active', startTime: T0, lastActivityTime: T0 + 5 * 60_000 }
const observed = () => true

test('relay offline: an active session reads "status unknown (relay offline)", not active', () => {
  assert.equal(SESSION_OFFLINE_TEXT, 'status unknown (relay offline)')
  assert.equal(sessionStatusKind(active, false, false, observed, true), 'offline')
  assert.equal(SESSION_STATUS_TEXT.offline, SESSION_OFFLINE_TEXT)
  // Online: unchanged
  assert.equal(sessionStatusKind(active, false, false, observed), 'active')
  assert.equal(sessionStatusKind(active, false, false, observed, false), 'active')
  // A completed session stays completed: its end was witnessed
  assert.equal(sessionStatusKind({ ...active, status: 'completed' }, false, false, observed, true), 'completed')
})

test('relay offline: the duration of an active session stops at its last activity', () => {
  const now = T0 + 72 * 60_000
  assert.equal(sessionTimeCell(active, now).text, '1h 12m')
  const frozen = sessionTimeCell(active, now, true)
  assert.equal(frozen.text, '5m 00s')
  assert.equal(frozen.label, '5m 00s until last activity')
  // It no longer grows with the clock
  assert.equal(sessionTimeCell(active, now + 3_600_000, true).text, '5m 00s')
  // The end was never observed: no figure
  assert.equal(sessionTimeCell({ ...active, lastActivityUnknown: true }, now, true).empty, true)
})

test('relay offline: unseen activity does not hide the offline status', () => {
  assert.equal(sessionStatusKind(active, true, false, observed, true), 'offline')
})
