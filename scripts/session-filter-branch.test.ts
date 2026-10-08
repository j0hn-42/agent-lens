import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isSessionInfo, sanitizeSessionInfo, type SessionInfo } from '../web/lib/bridge-types'
import {
  EMPTY_SESSION_FILTER, branchOptions, effectiveFilter, filterSessionList, isFilterActive, sessionMatches,
} from '../web/lib/session-filter'
import { sanitizePref, DEFAULT_UI_PREFS } from '../web/lib/ui-preferences'

// Filter by the branch recorded by the session transcript (#125)

const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ id, label: id, status: 'active', startTime: 0, lastActivityTime: 1, ...over })
const f = (over: Partial<typeof EMPTY_SESSION_FILTER>) => ({ ...EMPTY_SESSION_FILTER, ...over })
const ids = (xs: SessionInfo[]) => xs.map(x => x.id)
const branched = [s('on-feature', { branch: 'feat/login' }), s('on-main', { branch: 'main' }), s('unknown')]

test('the filter keeps the sessions of the branch; a session without a recorded branch never matches', () => {
  assert.deepEqual(ids(filterSessionList(branched, f({ branch: 'main' }))), ['on-main'])
  assert.deepEqual(ids(filterSessionList(branched, f({ branch: 'nope' }))), [])
  assert.equal(isFilterActive(f({ branch: 'main' })), true)
  assert.equal(sessionMatches(branched[2], f({ branch: 'main' })), false)
})

test('the text search covers the branch', () => {
  assert.deepEqual(ids(filterSessionList(branched, f({ query: 'FEAT/lo' }))), ['on-feature'])
})

test('options are the recorded branches, sorted; none recorded means no filter is offered', () => {
  assert.deepEqual(branchOptions(branched), ['feat/login', 'main'])
  assert.deepEqual(branchOptions([s('x')]), [])
})

test('a stored branch that no session has any more is ignored', () => {
  assert.equal(effectiveFilter(f({ branch: 'gone' }), branched).branch, null)
  assert.equal(effectiveFilter(f({ branch: 'main' }), branched).branch, 'main')
  assert.equal(effectiveFilter(f({ branch: 'main' }), [s('x')]).branch, null)
})

test('wire format and stored preference are validated', () => {
  const base = { id: 'x', label: 'x', status: 'active' as const, startTime: 0, lastActivityTime: 1 }
  assert.equal(isSessionInfo({ ...base, branch: 'main' }), true)
  assert.equal(isSessionInfo({ ...base, branch: 3 }), false)
  assert.equal(sanitizeSessionInfo({ ...base, branch: ' ma\nin ' }).branch, 'main')
  assert.equal('branch' in sanitizeSessionInfo({ ...base, branch: ' \u0001 ' }), false)
  assert.equal(DEFAULT_UI_PREFS.sessionFilterBranch, null)
  assert.equal(sanitizePref('sessionFilterBranch', 'feat/x'), 'feat/x')
  assert.equal(sanitizePref('sessionFilterBranch', ''), null)
  assert.equal(sanitizePref('sessionFilterBranch', 5), null)
})
