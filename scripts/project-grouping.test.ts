import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ALL_SESSIONS_ID, isSessionInfo, sanitizeSessionInfo, type SessionInfo } from '../web/lib/bridge-types'
import { buildSessionRows } from '../web/lib/session-tree'

// Grouping of the sessions by project (issue #62)

const session = (id: string, status: SessionInfo['status'], lastActivityTime: number, teamName?: string): SessionInfo => ({
  id, label: id, status, startTime: 0, lastActivityTime, teamName,
})
const inProject = (s: SessionInfo, projectId: string, projectName = projectId): SessionInfo => ({ ...s, projectId, projectName })

test('project grouping: sessions of one repo (worktrees included) sit together under a project row', () => {
  const sessions = [
    inProject(session('a1', 'active', 5), 'pa', 'alpha'), session('plain', 'active', 4),
    inProject(session('b1', 'active', 3), 'pb', 'beta'), inProject(session('a2', 'active', 2), 'pa', 'alpha'),
  ]
  const rows = buildSessionRows(sessions, [], new Map())
  assert.deepEqual(rows.map(r => r.id), [ALL_SESSIONS_ID, 'project:pa', 'a1', 'a2', 'project:pb', 'b1', 'project:none', 'plain'])
  const header = rows.find(r => r.id === 'project:pa')!
  assert.equal(header.kind, 'project')
  assert.equal(header.projectName, 'alpha')
  assert.equal(rows.find(r => r.id === 'a2')!.projectId, 'pa')
  assert.equal(rows.find(r => r.id === 'plain')!.projectId, undefined, 'outside git: no project of its own')
})

test('project grouping: sessions without a project get their own heading, never the last project\'s', () => {
  const sessions = [inProject(session('a1', 'active', 3), 'pa'), inProject(session('b1', 'active', 2), 'pb'), session('plain', 'active', 1)]
  const rows = buildSessionRows(sessions, [], new Map())
  assert.deepEqual(rows.map(r => r.id), [ALL_SESSIONS_ID, 'project:pa', 'a1', 'project:pb', 'b1', 'project:none', 'plain'])
  const header = rows.find(r => r.id === 'project:none')!
  assert.equal(header.kind, 'project')
  assert.equal(header.projectId, undefined)
  const all = [inProject(session('a1', 'active', 2), 'pa'), inProject(session('b1', 'active', 1), 'pb')]
  assert.ok(!buildSessionRows(all, [], new Map()).some(r => r.id === 'project:none'), 'no remainder heading when every session has a project')
})

test('project grouping: a single project (or none) adds no header', () => {
  const one = [inProject(session('a1', 'active', 2), 'pa'), inProject(session('a2', 'active', 1), 'pa')]
  assert.deepEqual(buildSessionRows(one, [], new Map()).map(r => r.id), [ALL_SESSIONS_ID, 'a1', 'a2'])
  assert.deepEqual(buildSessionRows([session('x', 'active', 1)], [], new Map()).map(r => r.id), [ALL_SESSIONS_ID, 'x'])
})

test('project grouping: team sessions stay under their team, groups follow the best-ranked session', () => {
  const sessions = [
    inProject(session('old', 'completed', 9), 'pa', 'alpha'),
    inProject(session('m1', 'active', 1, 'team1'), 'pa', 'alpha'),
    inProject(session('b1', 'active', 2), 'pb', 'beta'),
    inProject(session('a1', 'active', 1), 'pa', 'alpha'),
  ]
  const ids = buildSessionRows(sessions, [], new Map()).map(r => r.id)
  assert.deepEqual(ids, [ALL_SESSIONS_ID, 'team:team1', 'm1', 'project:pb', 'b1', 'project:pa', 'a1', 'old'])
})

test('project fields: validated, sanitised, dropped when unusable', () => {
  const base = { id: 's', label: 'l', status: 'active' as const, startTime: 1, lastActivityTime: 2 }
  assert.equal(isSessionInfo({ ...base, projectId: 'abc', projectName: 'repo' }), true)
  assert.equal(isSessionInfo({ ...base, projectId: 5 }), false)
  assert.equal(isSessionInfo({ ...base, projectName: {} }), false)
  const s = sanitizeSessionInfo({ ...base, projectId: 'ab\u0000c', projectName: ' re\npo '.repeat(50) })
  assert.equal(s.projectId, 'abc')
  // eslint-disable-next-line no-control-regex
  assert.ok(s.projectName!.length <= 80 && !/[\u0000-\u001f]/.test(s.projectName!))
  const half = sanitizeSessionInfo({ ...base, projectId: 'abc', projectName: ' \u0001 ' })
  assert.equal('projectId' in half, false, 'an id without a name is not a usable group')
  assert.equal('projectName' in half, false)
})
