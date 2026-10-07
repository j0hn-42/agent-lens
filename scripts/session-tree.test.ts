import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ALL_SESSIONS_ID, type SessionInfo } from '../web/lib/bridge-types'
import {
  buildAgentForests, buildSessionRows, countAgents, filterActiveSessions, filterActiveTeams, formatRelativeTime, selectionLabel, type AgentLike,
} from '../web/lib/session-tree'
import { SHORTCUTS } from '../web/lib/shortcuts'

const agent = (id: string, sessionId: string, parentKey: string | null, spawnTime = 0): AgentLike => ({
  id, sessionId, parentKey, name: id, state: 'idle', tokensUsed: 0, spawnTime,
})
const session = (id: string, status: SessionInfo['status'], lastActivityTime: number, teamName?: string): SessionInfo => ({
  id, label: id, status, startTime: 0, lastActivityTime, teamName,
})

test('agent forests: sub-agents nest under their parent, siblings follow spawn order', () => {
  const forests = buildAgentForests([
    agent('s1:sub2', 's1', 's1:main', 3), agent('s1:main', 's1', null, 1), agent('s1:sub1', 's1', 's1:main', 2),
    agent('s1:deep', 's1', 's1:sub1', 4), agent('s2:main', 's2', null, 1),
  ])
  const s1 = forests.get('s1')!
  assert.equal(s1.length, 1)
  assert.deepEqual(s1[0].children.map(c => c.agent.id), ['s1:sub1', 's1:sub2'])
  assert.deepEqual(s1[0].children[0].children.map(c => c.agent.id), ['s1:deep'])
  assert.equal(countAgents(s1), 4)
  assert.equal(forests.get('s2')!.length, 1)
})

test('agent forests: a missing, foreign or cyclic parent never hides an agent', () => {
  const forests = buildAgentForests([
    agent('a', 's1', 'gone', 1), agent('b', 's1', 's2:x', 2), agent('s2:x', 's2', null, 1),
    agent('c', 's1', 'd', 3), agent('d', 's1', 'c', 4), agent('self', 's1', 'self', 5),
  ])
  const ids = (forests.get('s1') ?? []).map(n => n.agent.id)
  assert.ok(ids.includes('a') && ids.includes('b') && ids.includes('self'))
  assert.equal(countAgents(forests.get('s1')!), 5, 'every agent of s1 is listed once')
})

test('session rows: All, then teams with their sessions, then the rest; active sessions first', () => {
  const sessions = [
    session('old', 'completed', 1), session('new', 'active', 5), session('m1', 'active', 3, 'alpha'), session('mid', 'active', 4),
  ]
  const rows = buildSessionRows(sessions, ['alpha'], buildAgentForests([agent('new:main', 'new', null)]))
  assert.deepEqual(rows.map(r => r.id), [ALL_SESSIONS_ID, 'team:alpha', 'm1', 'new', 'mid', 'old'])
  assert.equal(rows.find(r => r.id === 'new')!.agentCount, 1)
  assert.equal(rows.find(r => r.id === 'old')!.agentCount, 0)
  assert.deepEqual(buildSessionRows([], [], new Map()).map(r => r.id), [ALL_SESSIONS_ID])
})

test('session rows: agents of an unlisted session stay visible under the All row', () => {
  const rows = buildSessionRows([session('s1', 'active', 1)], [], buildAgentForests([agent('x:main', 'x', null), agent('s1:main', 's1', null)]))
  const all = rows.find(r => r.id === ALL_SESSIONS_ID)!
  assert.deepEqual(all.roots.map(n => n.agent.id), ['x:main'])
  assert.equal(all.agentCount, 1)
  assert.equal(rows.find(r => r.id === 's1')!.agentCount, 1)
})

test('active-only filter keeps active sessions and the selected one; teams need a remaining session or a working member', () => {
  const sessions = [session('a', 'active', 3), session('done', 'completed', 2), session('sel', 'completed', 1, 'beta'), session('m', 'completed', 1, 'alpha')]
  assert.deepEqual(filterActiveSessions(sessions, 'sel').map(s => s.id), ['a', 'sel'])
  assert.deepEqual(filterActiveSessions(sessions, null).map(s => s.id), ['a'])
  const kept = filterActiveSessions(sessions, 'sel')
  assert.deepEqual(filterActiveTeams(['alpha', 'beta', 'gamma'], kept, new Map([['gamma', 2]])), ['beta', 'gamma'])
  assert.deepEqual(filterActiveTeams(['alpha'], kept), [])
})

test('selection label and relative time', () => {
  const sessions = [{ id: 's1', label: 'My session' }]
  assert.equal(selectionLabel(null, sessions), 'All sessions')
  assert.equal(selectionLabel(ALL_SESSIONS_ID, sessions), 'All sessions')
  assert.equal(selectionLabel('team:alpha', sessions), 'Team alpha')
  assert.equal(selectionLabel('s1', sessions), 'My session')
  assert.equal(selectionLabel('gone', sessions), 'Session')
  assert.equal(formatRelativeTime(1000, 2000), 'just now')
  assert.equal(formatRelativeTime(0, 30_000), '30s ago')
  assert.equal(formatRelativeTime(0, 5 * 60_000), '5 min ago')
  assert.equal(formatRelativeTime(0, 3 * 3600_000), '3 h ago')
  assert.equal(formatRelativeTime(0, 2 * 86400_000), '2 d ago')
  assert.equal(formatRelativeTime(5000, 1000), 'just now')
})

test('the sessions list shortcut is documented and does not collide with another key', () => {
  assert.equal(SHORTCUTS.filter(s => s.key === 'l').length, 1)
  assert.equal(new Set(SHORTCUTS.map(s => s.key)).size, SHORTCUTS.length)
})
