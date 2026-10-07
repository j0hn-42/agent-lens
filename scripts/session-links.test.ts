import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SessionInfo } from '../web/lib/bridge-types'
import { isSessionInfo, pickAutoSelectSession } from '../web/lib/bridge-types'
import { deriveSessionLinks, MAX_LINK_SESSIONS, describeSessionLink } from '../web/lib/session-links'

const s = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, label: id, status: 'active', startTime: 100, lastActivityTime: 100, ...extra,
})
const ids = (links: ReturnType<typeof deriveSessionLinks>) => links.map(l => `${l.kind}:${l.parentId}>${l.childId}`)

test('a declared parent links the child (task)', () => {
  assert.deepEqual(ids(deriveSessionLinks([s('p'), s('c', { parentSessionId: 'p' })])), ['task:p>c'])
})

test('a declared parent that is not listed, a self-reference or a blank id produce no link', () => {
  assert.deepEqual(deriveSessionLinks([s('c', { parentSessionId: 'gone' })]), [])
  assert.deepEqual(deriveSessionLinks([s('c', { parentSessionId: 'c' })]), [])
  assert.deepEqual(deriveSessionLinks([s('p'), s('c', { parentSessionId: '' })]), [])
})

test('a worktree session links to the single session of the repository root', () => {
  const links = deriveSessionLinks([
    s('p', { cwd: '/home/me/repo', startTime: 10 }),
    s('c', { cwd: '/home/me/repo/.claude/worktrees/wf-1/src', startTime: 50 }),
  ])
  assert.deepEqual(ids(links), ['worktree:p>c'])
})

test('worktree: two candidate parents, a parent started later, or an unrelated cwd give no link', () => {
  const child = s('c', { cwd: '/r/.claude/worktrees/x', startTime: 50 })
  assert.deepEqual(deriveSessionLinks([s('p1', { cwd: '/r', startTime: 1 }), s('p2', { cwd: '/r', startTime: 2 }), child]), [])
  assert.deepEqual(deriveSessionLinks([s('p', { cwd: '/r', startTime: 60 }), child]), [])
  assert.deepEqual(deriveSessionLinks([s('p', { cwd: '/other', startTime: 1 }), child]), [])
  assert.deepEqual(deriveSessionLinks([s('p', { cwd: '/r2', startTime: 1 }), child]), [])
})

test('worktree: a bare marker without a worktree name is not a worktree', () => {
  assert.deepEqual(deriveSessionLinks([s('p', { cwd: '/r', startTime: 1 }), s('c', { cwd: '/r/.claude/worktrees/', startTime: 5 })]), [])
})

test('worktree: normalises separators and trailing slashes', () => {
  const links = deriveSessionLinks([
    s('p', { cwd: 'C:\\w\\repo\\', startTime: 1 }),
    s('c', { cwd: 'C:\\w\\repo\\.claude\\worktrees\\a', startTime: 2 }),
  ])
  assert.deepEqual(ids(links), ['worktree:p>c'])
})

test('conflict: the declared parent disagrees with the worktree parent, no link', () => {
  const links = deriveSessionLinks([
    s('p', { cwd: '/r', startTime: 1 }), s('other', { cwd: '/elsewhere', startTime: 1 }),
    s('c', { cwd: '/r/.claude/worktrees/x', startTime: 5, parentSessionId: 'other' }),
  ])
  assert.deepEqual(links, [])
})

test('declared and inferred parents that agree give one task link', () => {
  const links = deriveSessionLinks([
    s('p', { cwd: '/r', startTime: 1 }), s('c', { cwd: '/r/.claude/worktrees/x', startTime: 5, parentSessionId: 'p' }),
  ])
  assert.deepEqual(ids(links), ['task:p>c'])
})

test('duplicate ids: identical copies collapse, conflicting copies take no part in any link', () => {
  const p = s('p')
  assert.deepEqual(ids(deriveSessionLinks([p, p, s('c', { parentSessionId: 'p' })])), ['task:p>c'])
  assert.deepEqual(deriveSessionLinks([s('p'), s('c', { parentSessionId: 'p' }), s('c', { parentSessionId: 'x' })]), [])
  assert.deepEqual(deriveSessionLinks([s('p', { cwd: '/a' }), s('p', { cwd: '/b' }), s('c', { parentSessionId: 'p' })]), [])
})

test('cycles: every link of the cycle is dropped, a child hanging off it keeps its own', () => {
  assert.deepEqual(deriveSessionLinks([s('a', { parentSessionId: 'b' }), s('b', { parentSessionId: 'a' })]), [])
  const l = deriveSessionLinks([
    s('a', { parentSessionId: 'b' }), s('b', { parentSessionId: 'c' }), s('c', { parentSessionId: 'a' }), s('d', { parentSessionId: 'a' }),
  ])
  assert.deepEqual(ids(l), ['task:a>d'])
})

test('chains are kept: grandparent > parent > child (ordered by child id)', () => {
  const l = deriveSessionLinks([s('g'), s('p', { parentSessionId: 'g' }), s('c', { parentSessionId: 'p' })])
  assert.deepEqual(ids(l), ['task:p>c', 'task:g>p'])
})

test('bounded: only the most recent sessions are considered', () => {
  const list: SessionInfo[] = []
  for (let i = 0; i < MAX_LINK_SESSIONS + 50; i++) {
    list.push(s(`s${i}`, { lastActivityTime: i + 1, ...(i === 0 ? {} : { parentSessionId: 's0' }) }))
  }
  assert.deepEqual(deriveSessionLinks(list), [], 's0 is the oldest and is purged, so nobody links to it')
  const fresh = deriveSessionLinks(list.map(x => (x.id === 's0' ? { ...x, lastActivityTime: 1e9 } : x)))
  assert.equal(fresh.length, MAX_LINK_SESSIONS - 1)
})

test('describeSessionLink words the relation with the labels', () => {
  const sessions = [s('p', { label: 'Main' }), s('c', { label: 'Fix' })]
  assert.equal(describeSessionLink({ parentId: 'p', childId: 'c', kind: 'worktree' }, sessions), 'Fix appears to run in a worktree of Main')
  assert.equal(describeSessionLink({ parentId: 'p', childId: 'c', kind: 'task' }, sessions), 'Fix was launched by Main')
})

test('sanitizeSessionInfo cleans and caps the declared parent id', async () => {
  const { sanitizeSessionInfo, MAX_SESSION_ID_LEN } = await import('../web/lib/bridge-types')
  assert.equal(sanitizeSessionInfo({ ...s('c'), parentSessionId: ' p\u0000\n1 ' }).parentSessionId, 'p1')
  assert.equal(sanitizeSessionInfo({ ...s('c'), parentSessionId: 'x'.repeat(500) }).parentSessionId?.length, MAX_SESSION_ID_LEN)
  assert.ok(!('parentSessionId' in sanitizeSessionInfo({ ...s('c'), parentSessionId: '\u0000' })))
})

test('isSessionInfo accepts an optional string parentSessionId only', () => {
  assert.ok(isSessionInfo({ ...s('c'), parentSessionId: 'p' }))
  assert.ok(!isSessionInfo({ ...s('c'), parentSessionId: 3 }))
})

test('worktree: a parent that had already ended when the child started is not evidence', () => {
  const child = s('c', { cwd: '/r/.claude/worktrees/x', startTime: 500 })
  assert.deepEqual(deriveSessionLinks([s('old', { cwd: '/r', startTime: 1, lastActivityTime: 100, status: 'completed' }), child]), [])
  assert.deepEqual(ids(deriveSessionLinks([s('live', { cwd: '/r', startTime: 1, lastActivityTime: 900 }), child])), ['worktree:live>c'])
})

test('worktree: a root session pruned by the size bound still makes the remaining candidate ambiguous', () => {
  const list: SessionInfo[] = [
    s('p1', { cwd: '/r', startTime: 1, lastActivityTime: 1e9 }),
    s('p2', { cwd: '/r', startTime: 2, lastActivityTime: 5 }), // oldest: falls outside the bound
    s('c', { cwd: '/r/.claude/worktrees/x', startTime: 10, lastActivityTime: 1e9 }),
  ]
  for (let i = 0; i < MAX_LINK_SESSIONS; i++) list.push(s(`f${i}`, { lastActivityTime: 1e9 - 1 - i }))
  assert.deepEqual(deriveSessionLinks(list), [])
})

test('pickAutoSelectSession prefers active then recent, and never an index-only session', () => {
  const list = [
    s('idx', { status: 'completed', lastActivityTime: 9000, indexedOnly: true }),
    s('old', { status: 'completed', lastActivityTime: 10 }),
    s('recent', { status: 'completed', lastActivityTime: 50 }),
  ]
  assert.equal(pickAutoSelectSession(list), 'recent')
  assert.equal(pickAutoSelectSession([...list, s('act', { lastActivityTime: 1 })]), 'act')
  assert.equal(pickAutoSelectSession([list[0]]), undefined, 'only indexed sessions: nothing selected')
  assert.equal(pickAutoSelectSession([]), undefined)
})
