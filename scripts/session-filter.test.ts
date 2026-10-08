import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SessionInfo } from '../web/lib/bridge-types'
import {
  EMPTY_SESSION_FILTER, agentNamesBySession, effectiveFilter, filterSessionList, isFilterActive, projectOptions, runtimeOptions, sessionMatches,
} from '../web/lib/session-filter'
import { emptyMatch } from '../web/lib/ui-glossary'
import { sanitizePref, sanitizePrefs, DEFAULT_UI_PREFS } from '../web/lib/ui-preferences'

// Search and filter of the session list (#125)

const s = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ id, label: id, status: 'active', startTime: 0, lastActivityTime: 1, ...over })
const list = [
  s('fix-login', { runtime: 'claude', projectId: 'pa', projectName: 'alpha', workspace: '/w/alpha' }),
  s('refactor', { runtime: 'codex', projectId: 'pb', projectName: 'Beta', teamName: 'crew', memberName: 'lead' }),
  s('plain', { runtime: 'claude' }),
]
const f = (over: Partial<typeof EMPTY_SESSION_FILTER>) => ({ ...EMPTY_SESSION_FILTER, ...over })
const ids = (xs: SessionInfo[]) => xs.map(x => x.id)

test('filter: an empty filter keeps every session and is inactive', () => {
  assert.equal(isFilterActive(EMPTY_SESSION_FILTER), false)
  assert.equal(isFilterActive(f({ query: '   ' })), false)
  assert.deepEqual(ids(filterSessionList(list, EMPTY_SESSION_FILTER)), ['fix-login', 'refactor', 'plain'])
})

test('filter: text matches label, project, workspace, team and member, case-insensitively, all terms required', () => {
  assert.deepEqual(ids(filterSessionList(list, f({ query: 'LOGIN' }))), ['fix-login'])
  assert.deepEqual(ids(filterSessionList(list, f({ query: 'beta' }))), ['refactor'])
  assert.deepEqual(ids(filterSessionList(list, f({ query: '/w/alpha' }))), ['fix-login'])
  assert.deepEqual(ids(filterSessionList(list, f({ query: 'crew lead' }))), ['refactor'])
  assert.deepEqual(ids(filterSessionList(list, f({ query: 'beta login' }))), [])
})

test('filter: text also matches the agents of a session when the view knows them', () => {
  const names = agentNamesBySession([{ sessionId: 'plain', name: 'Reviewer' }, { sessionId: 'plain', name: 'worker' }])
  assert.deepEqual(ids(filterSessionList(list, f({ query: 'review' }), id => names.get(id) ?? [])), ['plain'])
  assert.deepEqual(ids(filterSessionList(list, f({ query: 'review' }))), [], 'no agent data: nothing invented')
})

test('filter: project and runtime combine with the text', () => {
  assert.deepEqual(ids(filterSessionList(list, f({ projectId: 'pa' }))), ['fix-login'])
  assert.deepEqual(ids(filterSessionList(list, f({ runtime: 'claude' }))), ['fix-login', 'plain'])
  assert.deepEqual(ids(filterSessionList(list, f({ runtime: 'claude', query: 'plain' }))), ['plain'])
  assert.deepEqual(ids(filterSessionList(list, f({ runtime: 'codex', projectId: 'pa' }))), [])
  assert.equal(sessionMatches(list[2], f({ projectId: 'pa' })), false, 'a session outside git matches no project')
})

test('filter: options list the projects and runtimes present', () => {
  assert.deepEqual(projectOptions(list), [{ projectId: 'pa', projectName: 'alpha' }, { projectId: 'pb', projectName: 'Beta' }])
  assert.deepEqual(runtimeOptions(list), ['claude', 'codex'])
  assert.deepEqual(runtimeOptions([s('x')]), [])
})

test('filter: a stored project that no session has any more is ignored, never an empty list', () => {
  assert.equal(effectiveFilter(f({ projectId: 'gone' }), list).projectId, null)
  assert.equal(effectiveFilter(f({ projectId: 'pa' }), list).projectId, 'pa')
})

test('filter: the empty match wording is the shared one', () => {
  assert.equal(emptyMatch('sessions'), 'No matching sessions')
})

test('ui-prefs: project and runtime filters persist, malformed values fall back to none', () => {
  assert.equal(DEFAULT_UI_PREFS.sessionFilterProject, null)
  assert.equal(DEFAULT_UI_PREFS.sessionFilterRuntime, null)
  assert.equal(sanitizePref('sessionFilterRuntime', 'codex'), 'codex')
  assert.equal(sanitizePref('sessionFilterRuntime', 'gemini'), null)
  assert.equal(sanitizePref('sessionFilterRuntime', 3), null)
  assert.equal(sanitizePref('sessionFilterProject', 'abc'), 'abc')
  assert.equal(sanitizePref('sessionFilterProject', ''), null)
  assert.equal(sanitizePref('sessionFilterProject', 'x'.repeat(1000)), null)
  const out = sanitizePrefs({ v: 1, prefs: { sessionFilterProject: 'p1', sessionFilterRuntime: 'claude' } })
  assert.equal(out.sessionFilterProject, 'p1')
  assert.equal(out.sessionFilterRuntime, 'claude')
})
