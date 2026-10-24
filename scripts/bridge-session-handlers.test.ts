import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SESSION_HANDLERS, type SessionHandlerCtx } from '../web/lib/bridge-session-handlers'
import { createSessionBuffers, appendSessionEvent, sessionEventCount } from '../web/lib/session-buffers'
import { createTeamTracker } from '../web/hooks/simulation/team-info'
import { SessionModelTracker } from '../web/lib/session-model'
import type { SessionInfo } from '../web/lib/vscode-bridge'
import type { SimulationEvent } from '../web/lib/agent-types'

const session = (id: string, over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, label: id, status: 'active', startTime: 1, lastActivityTime: 2, ...over })

/** A context made of plain values: the handlers only read and write through it */
function makeCtx(initial: SessionInfo[] = [], selected: string | null = null) {
  const calls = { notices: [] as string[], selectedSet: [] as (string | null)[], eventVersion: 0, models: 0, teamViews: 0, activity: [] as Set<string>[] }
  const ctx: SessionHandlerCtx & { sessions: SessionInfo[] } = {
    sessions: initial,
    updateSessions: update => { ctx.sessions = update(ctx.sessions) },
    selectedSessionIdRef: { current: selected },
    setSelectedSessionId: id => { calls.selectedSet.push(id) },
    sessionSwitchPendingRef: { current: false },
    pendingEventsRef: { current: [] as SimulationEvent[] },
    sessionBuffersRef: { current: createSessionBuffers() },
    allEventsRef: { current: [] as SimulationEvent[] },
    allBaseRef: { current: 0 },
    lastEventAtRef: { current: new Map<string, number>() },
    modelTrackerRef: { current: new SessionModelTracker() },
    teamTrackerRef: { current: createTeamTracker() },
    dismissedSessionsRef: { current: new Map<string, SessionInfo>() },
    setSessionModels: () => { calls.models++ },
    refreshTeamView: () => { calls.teamViews++ },
    setSessionsWithActivity: update => { calls.activity.push(update(new Set())) },
    bumpEventVersion: () => { calls.eventVersion++ },
    pushNotice: (_kind, message) => { calls.notices.push(message) },
    now: () => 1000,
  }
  return { ctx, calls }
}

test('list: stores the sessions and auto-selects the active one when nothing is selected', () => {
  const { ctx, calls } = makeCtx()
  SESSION_HANDLERS.list(ctx, [session('old', { status: 'completed' }), session('live')])
  assert.deepEqual(ctx.sessions.map(s => s.id), ['old', 'live'])
  assert.equal(ctx.selectedSessionIdRef.current, 'live')
  assert.deepEqual(calls.selectedSet, ['live'])
  assert.equal(ctx.sessionSwitchPendingRef.current, true)
})

test('list: never moves an existing selection', () => {
  const { ctx, calls } = makeCtx([], 'mine')
  SESSION_HANDLERS.list(ctx, [session('other')])
  assert.equal(ctx.selectedSessionIdRef.current, 'mine')
  assert.deepEqual(calls.selectedSet, [])
  assert.equal(ctx.sessionSwitchPendingRef.current, false)
})

test('started: a new session is appended and selected when nothing is selected', () => {
  const { ctx } = makeCtx()
  SESSION_HANDLERS.started(ctx, session('a'))
  assert.deepEqual(ctx.sessions.map(s => s.id), ['a'])
  assert.equal(ctx.selectedSessionIdRef.current, 'a')
  assert.equal(ctx.sessionSwitchPendingRef.current, true)
})

test('started: does not yank the user away, it pulses the new tab', () => {
  const { ctx, calls } = makeCtx([session('a')], 'a')
  SESSION_HANDLERS.started(ctx, session('b'))
  assert.equal(ctx.selectedSessionIdRef.current, 'a')
  assert.deepEqual([...calls.activity[0]], ['b'])
})

test('started: a resumed session turns active again, an imported one keeps what the relay says', () => {
  const { ctx } = makeCtx([session('a', { status: 'completed' }), session('b', { status: 'completed' }), session('i', { status: 'completed', imported: true })], 'a')
  SESSION_HANDLERS.started(ctx, session('a', { lastActivityTime: 500 }))
  SESSION_HANDLERS.started(ctx, session('b', { lastActivityTime: Number.NaN }))
  SESSION_HANDLERS.started(ctx, session('i', { status: 'completed', imported: true }))
  assert.equal(ctx.sessions.find(s => s.id === 'a')!.status, 'active')
  // The time the source gives (#365), not the moment the message arrived; `now` only when it gives none
  assert.equal(ctx.sessions.find(s => s.id === 'a')!.lastActivityTime, 500)
  assert.equal(ctx.sessions.find(s => s.id === 'b')!.lastActivityTime, 1000)
  assert.equal(ctx.sessions.find(s => s.id === 'i')!.status, 'completed')
})

test('updated and ended change only the named session', () => {
  const { ctx } = makeCtx([session('a'), session('b')])
  SESSION_HANDLERS.updated(ctx, { sessionId: 'a', label: 'renamed' })
  SESSION_HANDLERS.ended(ctx, 'b')
  assert.equal(ctx.sessions[0].label, 'renamed')
  assert.equal(ctx.sessions[0].status, 'active')
  assert.equal(ctx.sessions[1].status, 'completed')
})

test('updated: a project learnt after the start is merged, so the session joins its workspace', () => {
  const { ctx } = makeCtx([session('a'), session('b', { projectId: 'p0', projectName: 'old' })])
  SESSION_HANDLERS.updated(ctx, { sessionId: 'a', label: 'a', cwd: '/w/repo', projectId: 'p1', projectName: 'repo', branch: 'feat/x' })
  const a = ctx.sessions[0]
  assert.equal(a.projectId, 'p1')
  assert.equal(a.projectName, 'repo')
  assert.equal(a.cwd, '/w/repo')
  assert.equal(a.branch, 'feat/x')
  // A label-only update keeps the place already known
  SESSION_HANDLERS.updated(ctx, { sessionId: 'b', label: 'renamed' })
  assert.equal(ctx.sessions[1].projectId, 'p0')
  // Half a project is dropped, and an imported session keeps its own group
  SESSION_HANDLERS.updated(ctx, { sessionId: 'b', label: 'b', projectId: 'p9' })
  assert.equal(ctx.sessions[1].projectId, 'p0')
  const imported = makeCtx([session('i', { imported: true, projectId: 'imported', projectName: 'Imported' })]).ctx
  SESSION_HANDLERS.updated(imported, { sessionId: 'i', label: 'i', projectId: 'p1', projectName: 'repo' })
  assert.notEqual(imported.sessions[0].projectId, 'p1')
})

test('reset: clears every buffer and selection, and says so unless it is a plain panel reopen', () => {
  const { ctx, calls } = makeCtx([session('a')], 'a')
  appendSessionEvent(ctx.sessionBuffersRef.current, 'a', { time: 1, type: 'x', payload: {}, sessionId: 'a' } as unknown as SimulationEvent, 'a')
  ctx.allEventsRef.current.push({} as SimulationEvent)
  ctx.allBaseRef.current = 5
  ctx.lastEventAtRef.current.set('a', 1)
  ctx.dismissedSessionsRef.current.set('z', session('z'))
  SESSION_HANDLERS.reset(ctx, 'scope-changed')
  assert.deepEqual(ctx.sessions, [])
  assert.equal(ctx.selectedSessionIdRef.current, null)
  assert.equal(sessionEventCount(ctx.sessionBuffersRef.current, 'a'), 0)
  assert.equal(ctx.allEventsRef.current.length, 0)
  assert.equal(ctx.allBaseRef.current, 0)
  assert.equal(ctx.lastEventAtRef.current.size, 0)
  assert.equal(ctx.dismissedSessionsRef.current.size, 0)
  assert.deepEqual(calls.notices, ['Scope changed: the session view was reloaded'])
  SESSION_HANDLERS.reset(ctx, 'panel-reopened')
  SESSION_HANDLERS.reset(ctx, undefined as unknown as string)
  assert.deepEqual(calls.notices, ['Scope changed: the session view was reloaded', 'Session view was reset'])
})
