/**
 * Session lifecycle messages of the bridge (list / started / updated / ended / reset), one handler per type.
 *
 * The handlers only update the session list and the selection. Event flushing stays with the consumer
 * (the layout effect of the visualizer) to avoid races between an auto-flush here and its save/restore logic.
 * Everything they touch comes through `SessionHandlerCtx`, so they run without React.
 */
import type { MutableRefObject } from 'react'
import { ALL_SESSIONS_ID, pickAutoSelectSession, resumeSession, sanitizeSessionInfo, type SessionUpdate } from './bridge-types'
import { pruneReplayStamps } from '../hooks/simulation/session-visibility'
import type { createTeamTracker } from '../hooks/simulation/team-info'
import type { SessionModelTracker } from './session-model'
import type { SessionBuffers } from './session-buffers'
import { clearSessionBuffers } from './session-buffers'
import type { SimulationEvent } from './agent-types'
import type { BridgeNotice, SessionInfo } from './vscode-bridge'

type Ref<T> = Pick<MutableRefObject<T>, 'current'>

export interface SessionHandlerCtx {
  updateSessions: (update: (prev: SessionInfo[]) => SessionInfo[]) => void
  selectedSessionIdRef: Ref<string | null>
  setSelectedSessionId: (id: string | null) => void
  sessionSwitchPendingRef: Ref<boolean>
  pendingEventsRef: Ref<SimulationEvent[]>
  sessionBuffersRef: Ref<SessionBuffers>
  allEventsRef: Ref<SimulationEvent[]>
  allBaseRef: Ref<number>
  lastEventAtRef: Ref<Map<string, number>>
  modelTrackerRef: Ref<Pick<SessionModelTracker, 'clear'>>
  teamTrackerRef: Ref<Pick<ReturnType<typeof createTeamTracker>, 'clear'>>
  dismissedSessionsRef: Ref<Map<string, SessionInfo>>
  setSessionModels: (models: ReadonlyMap<string, string>) => void
  refreshTeamView: () => void
  setSessionsWithActivity: (update: (prev: Set<string>) => Set<string>) => void
  pushNotice: (kind: BridgeNotice['kind'], message: string) => void
  now: () => number
}

type Handlers = {
  list: (ctx: SessionHandlerCtx, data: SessionInfo[]) => void
  started: (ctx: SessionHandlerCtx, data: SessionInfo) => void
  updated: (ctx: SessionHandlerCtx, data: SessionUpdate) => void
  ended: (ctx: SessionHandlerCtx, data: string) => void
  reset: (ctx: SessionHandlerCtx, data: string) => void
}

/** Select a session now: hold event delivery until the consumer has swapped the simulation state */
function selectPending(ctx: SessionHandlerCtx, id: string): void {
  ctx.sessionSwitchPendingRef.current = true
  ctx.pendingEventsRef.current.length = 0
  ctx.selectedSessionIdRef.current = id
  ctx.setSelectedSessionId(id)
}

export const SESSION_HANDLERS: Handlers = {
  list(ctx, sessionList) {
    // Events replayed before the list arrived were stamped with the reception time: undo that for finished sessions
    pruneReplayStamps(ctx.lastEventAtRef.current, sessionList, ctx.now())
    ctx.updateSessions(() => sessionList)
    // Auto-select: prefer active sessions, then most recently active
    const autoId = ctx.selectedSessionIdRef.current ? undefined : pickAutoSelectSession(sessionList)
    if (autoId) selectPending(ctx, autoId)
  },

  started(ctx, session) {
    ctx.updateSessions(prev => {
      if (!prev.some(s => s.id === session.id)) return [...prev, session]
      // Session resumed after inactivity: mark active again (an imported one never is: keep what the relay says)
      return prev.map(s => {
        if (s.id !== session.id) return s
        if (session.imported) return session
        return resumeSession(s, session, ctx.now()) // now watched live, with the times the source gives
      })
    })
    const selected = ctx.selectedSessionIdRef.current
    if (!selected) {
      // Nothing selected yet: select the new session
      selectPending(ctx, session.id)
    } else if (selected !== session.id && selected !== ALL_SESSIONS_ID) {
      // Never yank the user away from what they are watching: pulse the new tab instead
      ctx.setSessionsWithActivity(prev => {
        if (prev.has(session.id)) return prev
        const next = new Set(prev)
        next.add(session.id)
        return next
      })
    }
  },

  updated(ctx, { sessionId, label, projectId, projectName, ...place }) {
    // A place learnt late (the transcript head had no cwd) completes the session; sanitized as on a start. A project
    // comes whole: half of one never mixes with the project already known
    const project = projectId && projectName ? { projectId, projectName } : {}
    ctx.updateSessions(prev => prev.map(s => (s.id === sessionId ? sanitizeSessionInfo({ ...s, ...place, ...project, label }) : s)))
  },

  ended(ctx, sessionId) {
    ctx.updateSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, status: 'completed' as const } : s)))
  },

  reset(ctx, reason) {
    // Panel was reopened: clear all stale state (and tell the user, non-blocking).
    // A plain panel reopen is routine (sent on every 'ready'): only announce real resets.
    if (reason === 'scope-changed') ctx.pushNotice('reset', 'Scope changed: the session view was reloaded')
    else if (reason !== 'panel-reopened') ctx.pushNotice('reset', 'Session view was reset')
    ctx.updateSessions(() => [])
    ctx.setSelectedSessionId(null)
    ctx.selectedSessionIdRef.current = null
    ctx.pendingEventsRef.current.length = 0
    clearSessionBuffers(ctx.sessionBuffersRef.current)
    ctx.modelTrackerRef.current.clear()
    ctx.setSessionModels(new Map())
    ctx.allEventsRef.current = []
    ctx.allBaseRef.current = 0
    ctx.lastEventAtRef.current.clear()
    ctx.teamTrackerRef.current.clear()
    ctx.refreshTeamView()
    ctx.setSessionsWithActivity(() => new Set())
    ctx.dismissedSessionsRef.current.clear()
  },
}
