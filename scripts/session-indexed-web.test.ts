/**
 * Sessions known only from the index (#66), web side: the index proves neither detection nor an end,
 * so such a session is never shown as completed (status kind 'indexed') and never drawn or counted
 * as finished in the 'All' view.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sessionStatusKind, SESSION_STATUS_TEXT } from '../web/lib/chrome-utils'
import { activeSessionIds, finishedSessionIds } from '../web/hooks/simulation/session-visibility'

const NOW = 10_000_000
const idx = { id: 'idx', status: 'completed' as const, lastActivityTime: NOW, indexedOnly: true }
const live = { id: 'live', status: 'completed' as const, lastActivityTime: NOW - 3_600_000 }

describe('sessionStatusKind with indexedOnly', () => {
  it("is 'indexed', whatever the status, the activity or the selection", () => {
    for (const status of ['active', 'completed'] as const) {
      for (const hasActivity of [false, true]) {
        for (const selected of [false, true]) {
          assert.equal(sessionStatusKind({ id: 'x', status, indexedOnly: true }, hasActivity, selected, () => true), 'indexed')
        }
      }
    }
  })
  it('never reads as completed in the visible text', () => {
    assert.notEqual(SESSION_STATUS_TEXT.indexed, SESSION_STATUS_TEXT.completed)
  })
  it('a session without the flag keeps its regular kind', () => {
    assert.equal(sessionStatusKind({ id: 'x', status: 'completed' }, false, false), 'completed')
  })
})

describe('session visibility with indexedOnly', () => {
  it('an indexed session is not active, even recent, selected, or in a working team', () => {
    const withTeam = { ...idx, teamName: 'alpha' }
    const ids = activeSessionIds({
      sessions: [withTeam],
      lastEventAt: undefined,
      selectedId: 'idx',
      teamSessions: new Map([['alpha', new Set(['idx'])]]),
      teamWorking: new Map([['alpha', 2]]),
      now: NOW,
    })
    assert.ok(!ids.has('idx'))
  })
  it('an indexed session is not listed among the finished ones', () => {
    const active = activeSessionIds({ sessions: [idx, live], now: NOW })
    assert.deepEqual(finishedSessionIds([idx, live], active), ['live'])
  })
})
