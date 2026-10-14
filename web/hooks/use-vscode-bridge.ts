'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { ALL_SESSIONS_ID, parseTeamSelection, pickAutoSelectSession, toSimulationEvent, type SystemSample } from '@/lib/bridge-types'
import { SESSION_ALIASES_STORAGE_KEY, applyAliases, parseAliases, serializeAliases, setAlias } from '@/lib/session-aliases'
import { SessionModelTracker } from '@/lib/session-model'
import { createTeamTracker, teamSessionIds, eventMatchesSelection, type GroupSummary } from '@/hooks/simulation/team-info'
import {
  activeSessionIds, finishedSessionIds, parseShowFinished, shouldStampActivity, pruneReplayStamps, visibilityKey, restrictToProject, SHOW_FINISHED_STORAGE_KEY,
} from '@/hooks/simulation/session-visibility'
import {
  vscodeBridge, type ConnectionStatus, type AgentEvent, type SessionInfo, type BridgeNotice,
  type PermissionBridgeMessage, type PermissionRequestMessage,
} from '@/lib/vscode-bridge'
import type { PermissionAction } from '@/lib/bridge-types'
import { redirectMessage } from '@/lib/permission-requests'
import { useReconnectingSource } from '@/hooks/use-reconnecting-source'
import type { SimulationEvent, TeamSummary } from '@/lib/agent-types'
import { MOCK_SESSIONS } from '@/lib/mock-scenario'
import { applyRelayScope, fetchRelayScopeState, type RelayScope, type RelayScopeState } from '@/lib/relay-scope'
import {
  createSessionBuffers, appendSessionEvent, releaseSessionBuffer, clearSessionBuffers, sessionEventCount, sessionEventsFrom,
  bufferedEventCount, sessionExportSlice,
} from '@/lib/session-buffers'
import { isLaunchMessage, parseLaunchStatus, reduceLaunches, type LaunchView } from '@/lib/launch-client'
import { parseSystemSample, pushSample } from '@/lib/system-stats'
import { SESSION_HANDLERS, type SessionHandlerCtx } from '@/lib/bridge-session-handlers'

export interface UseVSCodeBridgeOptions {
  /** Ask the relay for a single session only (events of other sessions are rejected). Default: every session. */
  relaySessionId?: string | null
  /** Project the 'All' view is narrowed to (#291); null = every project. A project nobody belongs to any more is ignored. */
  projectScope?: string | null
}

interface BridgeHookResult {
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** Events received from VS Code extension, converted to SimulationEvent format */
  pendingEvents: readonly SimulationEvent[]
  /** Call after consuming events to clear the queue */
  consumeEvents: () => void
  /** Whether to show mock data (standalone mode or explicit config) */
  useMockData: boolean
  /** Whether CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set — caps context window to 200k */
  disable1MContext: boolean
  /** Claude Code hooks installed; undefined when the source does not say */
  hooksConfigured: boolean | undefined
  /** Open a file in the VS Code editor */
  bridgeOpenFile: (filePath: string, line?: number) => void
  bridgeOpenTerminal: (sessionId: string) => void
  /** Known sessions from the extension (label replaced by the user's own name when renamed, #246) */
  sessions: SessionInfo[]
  /** Give a session a name of your own (kept in this browser); an empty name restores the original label */
  renameSession: (sessionId: string, name: string) => void
  /** Currently selected session ID */
  selectedSessionId: string | null
  /** Select a session to view (does not flush events — call flushSessionEvents after state swap). */
  selectSession: (sessionId: string | null) => void
  /** Flush buffered events for a session into pending. Call from useLayoutEffect after state swap. */
  flushSessionEvents: (sessionId: string, fromIndex?: number) => void
  /** Get the current event count for a session (for save/restore) */
  getSessionEventCount: (sessionId: string) => number
  /** Buffered events of a real session for an export (#237), with how many were dropped before them */
  getSessionEvents: (sessionId: string) => { events: SimulationEvent[]; droppedBefore: number }
  /** Events of a real session still in memory (0 for 'All', a team or an unknown session) */
  getBufferedEventCount: (sessionId: string) => number
  /** Ref to the currently selected session ID — updated synchronously, not via React state */
  selectedSessionIdRef: React.RefObject<string | null>
  /** True while the 'All' tab (union of every session) is selected */
  isAllSelected: boolean
  /** Agent Teams seen in any session (selected or not), by team name */
  teams: Map<string, TeamSummary>
  /** Members currently working, per team name */
  teamWorking: Map<string, number>
  /** Tracked members and done members per team key (feeds isGroupActive) */
  teamSummaries: Map<string, GroupSummary>
  /** Members known per team (team config or teammates seen) */
  teamMemberCounts: Map<string, number>
  /** 'All' also shows the finished sessions (persisted preference) */
  showFinished: boolean
  setShowFinished: (show: boolean) => void
  /** Sessions the 'All' view shows (null = every session); changes whenever the shown set changes */
  allViewSessionIds: ReadonlySet<string> | null
  /** Identity of the 'All' view's shown set: a change means the union simulation must be rebuilt */
  allViewKey: string
  /** Sessions of the list that count as finished (hidden from 'All' unless showFinished) */
  finishedSessionCount: number
  /** Session IDs that have received events while not selected */
  sessionsWithActivity: Set<string>
  /** Model ID of each session (main agent's model), for the sessions that reported one */
  sessionModels: ReadonlyMap<string, string>
  /** Remove a session from the list */
  removeSession: (sessionId: string) => void
  /** Undo a removeSession call (re-adds the dismissed session). Returns true if it was restored. */
  restoreSession: (sessionId: string) => boolean
  /** Switch to the built-in demo scenario (empty-state "Load demo" action) */
  loadDemo: () => void
  /** Relay port when known (standalone mode), for user-facing messages */
  relayPort: string
  /** Origin of the relay HTTP API ('' = same origin) when a relay feeds this view, else null (extension / demo) */
  relayOrigin: string | null
  /** What the relay says it scans (GET /status); null = no relay, or its answer cannot be proven (#291) */
  relayScope: RelayScopeState | null
  /** A change of scope is being applied */
  relayScopePending: boolean
  /** Why the last change of scope failed (the shown scope is still the scanned one) */
  relayScopeError: string | null
  /** Ask the relay to change its scope; the view reloads once it confirmed. Resolves false when it did not. */
  setRelayScope: (scope: RelayScope) => Promise<boolean>
  /** True after the relay SSE connection failed and until it reconnects */
  relayUnreachable: boolean
  /** "reconnecting (attempt N, retry in Xs)" while the relay link is down, else null */
  connectionDetail: string | null
  /** Consecutive relay connection failures (0 when connected) */
  reconnectAttempt: number
  /** 'polling' after repeated SSE failures: only reachability is probed until the relay answers */
  relayLinkMode: 'sse' | 'polling'
  /** Latest non-blocking notice (parse failure, session reset, relay state); consumers toast it */
  notice: BridgeNotice | null
  /** Agent launches (#229): present only when GET /status of a SAME-ORIGIN relay has `launch` (--allow-launch).
   *  `launches` is what the relay reported (SSE `launch` / `launch-list` and the status), by id. */
  launch: { maxConcurrent: number; launches: ReadonlyMap<string, LaunchView> } | null
  /** Machine health (#357): the relay's `system-stats` samples, oldest first, bounded. Empty until the relay sends one,
   *  while the link is down, and always in VS Code and demo mode (the relay stream is not used there). */
  systemStats: readonly SystemSample[]
}

export const PARSE_NOTICE_INTERVAL_MS = 10_000

/** How often the 'active session' rule is re-evaluated for the passage of time */
const VISIBILITY_TICK_MS = 30_000
/** Sessions remembered for their last event time (oldest dropped) */
const MAX_LAST_EVENT_SESSIONS = 1000

/** Max events kept in the arrival-order buffer that feeds the 'All' tab (oldest are dropped) */
const MAX_ALL_BUFFER = 50_000

/**
 * Connects the VS Code bridge to the React app.
 * When running standalone, returns useMockData=true and no events.
 * When inside VS Code, receives events and forwards control commands.
 *
 * Supports multi-session: events are buffered per-session so switching
 * sessions replays the correct event history.
 */
export function useVSCodeBridge(options?: UseVSCodeBridgeOptions): BridgeHookResult {
  const [isVSCode, setIsVSCode] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [useMockData, setUseMockData] = useState(
    process.env.NEXT_PUBLIC_DEMO !== '0'
  )
  const [disable1MContext, setDisable1MContext] = useState(false)
  const [hooksConfigured, setHooksConfigured] = useState<boolean | undefined>(undefined)
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  // Absolute position (in the buffer of the selection) of the first event waiting in pendingEventsRef: what
  // is behind it was handed to the simulation, what is at or after it was not (#248)
  const pendingCursorRef = useRef(0)
  // The consumed cursor of the session being left, taken when the selection changes and kept until the state
  // swap is done: events received in between sit in the buffer but reach no queue
  const outgoingCursorRef = useRef<{ id: string; cursor: number } | null>(null)
  const [, setEventVersion] = useState(0) // trigger re-render on new events

  // Session state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const sessionsRef = useRef<SessionInfo[]>([])
  const [aliases, setAliases] = useState<ReadonlyMap<string, string>>(() => new Map())
  const displaySessions = useMemo(() => applyAliases(sessions, aliases), [sessions, aliases])
  const renameSession = useCallback((sessionId: string, name: string) => {
    setAliases(prev => {
      const next = setAlias(prev, sessionId, name)
      try { localStorage.setItem(SESSION_ALIASES_STORAGE_KEY, serializeAliases(next)) } catch { /* storage unavailable: the name lasts for this page */ }
      return next
    })
  }, [])
  useEffect(() => {
    try { setAliases(parseAliases(localStorage.getItem(SESSION_ALIASES_STORAGE_KEY))) } catch { /* storage unavailable */ }
  }, [])
  /** The tour demo declares its sessions (a relay would list them); true while only the demo lists them */
  const demoSessionsRef = useRef(false)
  /** Every change of the session list goes through here so the ref is current before React re-renders
   *  (the relay sends the list and the replayed events in the same tick). */
  const updateSessions = useCallback((update: (prev: SessionInfo[]) => SessionInfo[]) => {
    const next = update(sessionsRef.current)
    sessionsRef.current = next
    setSessions(next)
  }, [])
  // Teams are tracked over the whole event stream so tabs stay correct whichever tab is selected
  const teamTrackerRef = useRef(createTeamTracker())
  const modelTrackerRef = useRef(new SessionModelTracker())
  const [sessionModels, setSessionModels] = useState<ReadonlyMap<string, string>>(new Map())
  const [teamView, setTeamView] = useState<{ teams: Map<string, TeamSummary>; working: Map<string, number>; members: Map<string, number>; summaries: Map<string, GroupSummary> }>(
    () => ({ teams: new Map(), working: new Map(), members: new Map(), summaries: new Map() }),
  )
  const refreshTeamView = useCallback(() => {
    const tracker = teamTrackerRef.current
    const working = new Map<string, number>()
    const members = new Map<string, number>()
    const summaries = new Map<string, GroupSummary>()
    for (const name of tracker.teams.keys()) { working.set(name, tracker.working(name)); members.set(name, tracker.memberCount(name)); summaries.set(name, tracker.summary(name)) }
    setTeamView({ teams: new Map(tracker.teams), working, members, summaries })
  }, [])
  /** A real source took over: drop the sessions (and the All selection) that only the demo declared */
  const leaveDemo = useCallback(() => {
    setUseMockData(false)
    if (!demoSessionsRef.current) return
    demoSessionsRef.current = false
    updateSessions(prev => prev.filter(s => !MOCK_SESSIONS.some(m => m.id === s.id)))
    if (selectedSessionIdRef.current === ALL_SESSIONS_ID) { selectedSessionIdRef.current = null; setSelectedSessionId(null) }
  }, [updateSessions])
  // Seeded after mount: the scenario is read from the URL, which the server render cannot know
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DEMO === '0' || MOCK_SESSIONS.length === 0 || sessionsRef.current.length > 0) return
    demoSessionsRef.current = true
    updateSessions(() => MOCK_SESSIONS)
    selectedSessionIdRef.current = ALL_SESSIONS_ID
    setSelectedSessionId(ALL_SESSIONS_ID)
  }, [updateSessions])
  // 'All' shows only the active sessions unless the user asked for the finished ones too
  const [showFinished, setShowFinishedState] = useState(false)
  const showFinishedRef = useRef(false)
  const lastEventAtRef = useRef<Map<string, number>>(new Map())
  /** Sessions shown in 'All' (null = every one); read synchronously by the event filter */
  const visibleRef = useRef<ReadonlySet<string> | null>(null)
  const projectScopeRef = useRef<string | null>(options?.projectScope ?? null)
  const [visibility, setVisibility] = useState<{ key: string; ids: ReadonlySet<string> | null; finished: number }>({ key: '*', ids: null, finished: 0 })
  /** Whether an event of `sessionId` belongs to the selected view (session, All, or team pseudo selection) */
  const matchesSelection = useCallback((selected: string | null, sessionId: string | undefined): boolean =>
    eventMatchesSelection(selected, sessionId, teamTrackerRef.current, sessionsRef.current, visibleRef.current), [])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  /** Bounded per-session buffers (cap, session count, absolute positions): see lib/session-buffers */
  const sessionBuffersRef = useRef(createSessionBuffers())
  /** Every event in arrival order (feeds the 'All' tab). `allBaseRef` counts events trimmed from its front,
   *  so positions stay absolute and survive the cap. */
  const allEventsRef = useRef<SimulationEvent[]>([])
  const allBaseRef = useRef(0)
  /** True while a session switch is pending (between auto-select and useLayoutEffect).
   *  Prevents the animation frame from processing events in the wrong simulation context. */
  const sessionSwitchPendingRef = useRef(false)

  /** Re-evaluate which sessions 'All' shows; publishes a change (and parks event delivery while the union is rebuilt). */
  const recomputeVisible = useCallback(() => {
    let next: Set<string> | null = null
    let finished = 0
    const tracker = teamTrackerRef.current
    const active = activeSessionIds({
      sessions: sessionsRef.current,
      lastEventAt: lastEventAtRef.current,
      selectedId: selectedSessionIdRef.current,
      teamSessions: new Map(Array.from(tracker.teams.keys(), name => [name, tracker.sessionsOf(name)] as const)),
      teamWorking: new Map(Array.from(tracker.teams.keys(), name => [name, tracker.working(name)] as const)),
      teamSummaries: new Map(Array.from(tracker.teams.keys(), name => [name, tracker.summary(name)] as const)),
      now: Date.now(),
    })
    finished = finishedSessionIds(sessionsRef.current, active).length
    if (!showFinishedRef.current) next = active
    // A project scope narrows the view to that project's sessions (#291), whatever their activity
    const restricted = restrictToProject(next, sessionsRef.current, projectScopeRef.current)
    next = restricted === null ? null : new Set(restricted)
    const key = visibilityKey(next)
    const prevKey = visibilityKey(visibleRef.current)
    visibleRef.current = next
    setVisibility(prev => (prev.key === key && prev.finished === finished ? prev : { key, ids: next, finished }))
    if (key !== prevKey && selectedSessionIdRef.current === ALL_SESSIONS_ID) {
      // The union changes: hold events until the consumer rebuilds it from the buffer
      sessionSwitchPendingRef.current = true
      pendingEventsRef.current.length = 0
    }
  }, [])

  const setShowFinished = useCallback((show: boolean) => {
    showFinishedRef.current = show
    setShowFinishedState(show)
    try { localStorage.setItem(SHOW_FINISHED_STORAGE_KEY, String(show)) } catch { /* storage unavailable */ }
    recomputeVisible()
  }, [recomputeVisible])

  // Restore the persisted preference once on mount
  useEffect(() => {
    try {
      if (parseShowFinished(localStorage.getItem(SHOW_FINISHED_STORAGE_KEY))) {
        showFinishedRef.current = true
        setShowFinishedState(true)
      }
    } catch { /* storage unavailable */ }
    recomputeVisible()
  }, [recomputeVisible])
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())
  const [relayUnreachable, setRelayUnreachable] = useState(false)
  const [relayScope, setRelayScopeState] = useState<RelayScopeState | null>(null)
  const [relayScopePending, setRelayScopePending] = useState(false)
  const [relayScopeError, setRelayScopeError] = useState<string | null>(null)
  /** Bumped to open a new relay connection (and replay) after the scope changed */
  const [connectionGeneration, setConnectionGeneration] = useState(0)
  /** Scope the current view was built for: a change reloads the view once, whoever announced it first */
  const syncedScopeRef = useRef<RelayScope | null>(null)
  const [notice, setNotice] = useState<BridgeNotice | null>(null)
  const noticeIdRef = useRef(0)
  const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
  const pushNotice = useCallback((kind: BridgeNotice['kind'], message: string) => {
    setNotice({ id: ++noticeIdRef.current, kind, message })
  }, [])

  // Relay mode: dev server or standalone CLI, outside VS Code (the extension feeds events by postMessage there)
  const isRelayMode = process.env.AGENT_LENS_STANDALONE === '1'
    || (process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_DEMO === '0')
  const relayEnabled = isRelayMode && !!vscodeBridge && !vscodeBridge.isVSCode
  const lastParseNoticeRef = useRef(0)
  const wasDownRef = useRef(false)
  // Launches reported by the relay (#229). Read from the relay stream only, never from window messages:
  // a frame that embeds the page cannot make up a launch.
  const [launches, setLaunches] = useState<ReadonlyMap<string, LaunchView>>(() => new Map())
  const [launchMax, setLaunchMax] = useState<number | null>(null)
  // Machine health (#357): from the relay stream only, like the launches
  const [systemStats, setSystemStats] = useState<readonly SystemSample[]>([])
  const source = useReconnectingSource({
    enabled: relayEnabled,
    origin: relayPort ? `http://127.0.0.1:${relayPort}` : '',
    sessionId: options?.relaySessionId ?? null,
    generation: connectionGeneration,
    onMessage: data => {
      if (isLaunchMessage(data)) { setLaunches(prev => reduceLaunches(prev, data)); return }
      if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'system-stats') {
        const next = parseSystemSample((data as { sample?: unknown }).sample)
        if (next) setSystemStats(prev => pushSample(prev, next))
        return
      }
      vscodeBridge?.dispatch(data)
    },
    onParseError: () => {
      // Surface malformed relay payloads without spamming: at most one notice per interval
      const now = Date.now()
      if (now - lastParseNoticeRef.current > PARSE_NOTICE_INTERVAL_MS) {
        lastParseNoticeRef.current = now
        pushNotice('parse-error', 'Received malformed data from the relay; some events were skipped')
      }
    },
  })

  useEffect(() => {
    if (!relayEnabled) return
    setConnectionStatus(source.status)
    if (source.status === 'connected') {
      setRelayUnreachable(false)
      leaveDemo()
      if (wasDownRef.current) {
        wasDownRef.current = false
        pushNotice('relay-up', 'Relay reconnected')
      }
    } else if (source.status === 'disconnected') {
      setRelayUnreachable(true)
      if (!wasDownRef.current) {
        wasDownRef.current = true
        pushNotice('relay-down', relayPort ? `Relay unreachable on :${relayPort}` : 'Relay unreachable')
      }
    }
  }, [relayEnabled, source, pushNotice, relayPort, leaveDemo])

  // Hooks state from GET /status, only when the relay watches Claude Code (otherwise the flag says nothing)
  useEffect(() => {
    if (!relayEnabled || source.status !== 'connected' || !relayPort) return
    const ctl = new AbortController()
    fetch(`http://127.0.0.1:${relayPort}/status`, { signal: ctl.signal, cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        const watchesClaude = Array.isArray(j?.runtimes) && j.runtimes.includes('claude')
        setHooksConfigured(watchesClaude && typeof j.hooksConfigured === 'boolean' ? j.hooksConfigured : undefined)
        setDisable1MContext(watchesClaude && j.disable1MContext === true)
      })
      .catch(() => {})
    return () => ctl.abort()
  }, [relayEnabled, source.status, relayPort])

  // Scope of the discovery (#291): what the relay REPORTS it scans, read from GET /status; never what was asked
  const relayOrigin = relayEnabled ? (relayPort ? `http://127.0.0.1:${relayPort}` : '') : null
  const relayOriginRef = useRef(relayOrigin)
  relayOriginRef.current = relayOrigin
  const refreshRelayScope = useCallback(async (signal?: AbortSignal) => {
    const origin = relayOriginRef.current
    if (origin === null) return
    const state = await fetchRelayScopeState(origin, signal)
    if (signal?.aborted) return
    setRelayScopeState(state)
    if (state && syncedScopeRef.current === null) syncedScopeRef.current = state.scope
  }, [])
  useEffect(() => {
    if (!relayEnabled || source.status !== 'connected') return
    const ctl = new AbortController()
    void refreshRelayScope(ctl.signal)
    return () => ctl.abort()
  }, [relayEnabled, source.status, refreshRelayScope])
  useEffect(() => { if (!relayEnabled) { setRelayScopeState(null); syncedScopeRef.current = null } }, [relayEnabled])

  // A buffer from a link that is gone would show old figures as current
  useEffect(() => {
    if (!relayEnabled || source.status !== 'connected') setSystemStats(prev => (prev.length > 0 ? [] : prev))
  }, [relayEnabled, source.status])

  // Launching (#229): only a page served by the relay itself (same origin) can send POST /launch. The relay answers
  // no CORS preflight, which a request with Authorization and a JSON body needs, so the dev server (:3000) and the
  // VS Code webview never offer it. Read on each connection: `launch` is absent unless --allow-launch.
  useEffect(() => {
    if (!relayEnabled || source.status !== 'connected' || relayOrigin !== '') { setLaunchMax(null); setLaunches(prev => (prev.size > 0 ? new Map() : prev)); return }
    const ctl = new AbortController()
    fetch('/status', { signal: ctl.signal, cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        if (ctl.signal.aborted) return
        const status = parseLaunchStatus(j)
        setLaunchMax(status ? status.maxConcurrent : null)
        // The status is a snapshot that is authoritative, an empty one included: a relay restarted under us knows no launch
        setLaunches(prev => (status ? reduceLaunches(prev, { type: 'launch-list', launches: status.launches }) : prev.size > 0 ? new Map() : prev))
      })
      .catch(() => { if (!ctl.signal.aborted) { setLaunchMax(null); setLaunches(prev => (prev.size > 0 ? new Map() : prev)) } })
    return () => ctl.abort()
  }, [relayEnabled, source.status, relayOrigin])
  const launch = useMemo(() => (launchMax === null ? null : { maxConcurrent: launchMax, launches }), [launchMax, launches])

  /** The relay scans another scope: reload the view once (sessions and replay of the old scope must not linger), then re-read the status. */
  const syncToScope = useCallback((scope: RelayScope) => {
    if (syncedScopeRef.current === scope) { void refreshRelayScope(); return }
    syncedScopeRef.current = scope
    vscodeBridge?.dispatch({ type: 'reset', reason: 'scope-changed' })
    setConnectionGeneration(g => g + 1)
    void refreshRelayScope()
  }, [refreshRelayScope])
  useEffect(() => {
    if (!relayEnabled || !vscodeBridge) return
    return vscodeBridge.onRelayScope(all => syncToScope(all ? 'all' : 'workspace'))
  }, [relayEnabled, syncToScope])

  const setRelayScope = useCallback(async (scope: RelayScope): Promise<boolean> => {
    const origin = relayOriginRef.current
    if (origin === null) return false
    setRelayScopePending(true)
    setRelayScopeError(null)
    const result = await applyRelayScope(origin, scope)
    setRelayScopePending(false)
    if (!result.ok) {
      setRelayScopeError(result.reason)
      void refreshRelayScope() // whatever happened, show what the relay really scans
      return false
    }
    syncToScope(scope)
    return true
  }, [refreshRelayScope, syncToScope])

  // The project scope is an input of the 'All' view: re-evaluate when it changes
  const projectScope = options?.projectScope ?? null
  useEffect(() => {
    projectScopeRef.current = projectScope
    recomputeVisible()
  }, [projectScope, recomputeVisible])

  // Without a relay to wait for: unless the VS Code init message arrives, we are offline.
  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge || bridge.isVSCode || isRelayMode) return
    const t = setTimeout(() => {
      setConnectionStatus(s => (s === 'connecting' && !bridge.isVSCode ? 'disconnected' : s))
    }, 1500)
    return () => clearTimeout(t)
  }, [isRelayMode])

  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge) { return }

    // Listen for bridge initialization (event-driven, no polling)
    const unsubInit = bridge.onInit(() => {
      setIsVSCode(true)
      leaveDemo()
    })

    // Listen for events — buffer by session, deliver to pending if session matches.
    // selectedSessionIdRef is updated synchronously (not via React state) so it's
    // always current even before React re-renders.
    const unsubEvent = bridge.onEvent((event: AgentEvent) => {
      const simEvent: SimulationEvent = toSimulationEvent(event)

      if (teamTrackerRef.current.ingest(simEvent)) refreshTeamView()
      if (modelTrackerRef.current.ingest(simEvent)) setSessionModels(modelTrackerRef.current.snapshot())

      // Remember when each session last spoke (bounded), and re-evaluate when a hidden one wakes up
      if (event.sessionId) {
        const last = lastEventAtRef.current
        last.delete(event.sessionId)
        // Replayed history of a finished session is not activity: only stamp what can be live
        const now = Date.now()
        if (shouldStampActivity(sessionsRef.current.find(s => s.id === event.sessionId), now)) last.set(event.sessionId, now)
        if (last.size > MAX_LAST_EVENT_SESSIONS) {
          const oldest = last.keys().next().value
          if (oldest !== undefined) last.delete(oldest)
        }
        if (visibleRef.current && !visibleRef.current.has(event.sessionId)) recomputeVisible()
      }

      // Positions the event will take in the buffers, read before it is appended
      const sessionPosition = event.sessionId ? sessionEventCount(sessionBuffersRef.current, event.sessionId) : 0
      const allPosition = allBaseRef.current + allEventsRef.current.length
      // Always buffer by session (for replay on session switch)
      if (event.sessionId) {
        appendSessionEvent(sessionBuffersRef.current, event.sessionId, simEvent, selectedSessionIdRef.current)
      }
      // ... and in arrival order for the 'All' tab
      allEventsRef.current.push(simEvent)
      if (allEventsRef.current.length > MAX_ALL_BUFFER) {
        const over = allEventsRef.current.length - MAX_ALL_BUFFER
        allEventsRef.current.splice(0, over)
        allBaseRef.current += over
      }

      // Deliver to pending if session matches (ref is always current). The 'All' tab receives every event.
      // Skip if a session switch is pending — useLayoutEffect will flush
      // from the session buffer once the simulation state is swapped.
      const selected = selectedSessionIdRef.current
      const matches = matchesSelection(selected, event.sessionId)
      if (selected && matches && !sessionSwitchPendingRef.current) {
        if (pendingEventsRef.current.length === 0) {
          pendingCursorRef.current = selected === ALL_SESSIONS_ID || parseTeamSelection(selected) !== null ? allPosition : sessionPosition
        }
        pendingEventsRef.current.push(simEvent)
        setEventVersion(v => v + 1)
      } else if (event.sessionId && !matches) {
        // Track background activity for unselected sessions
        setSessionsWithActivity(prev => {
          if (prev.has(event.sessionId!)) return prev
          const next = new Set(prev)
          next.add(event.sessionId!)
          return next
        })
      }

      // Re-add dismissed sessions when new events arrive
      if (event.sessionId && dismissedSessionsRef.current.has(event.sessionId)) {
        const saved = dismissedSessionsRef.current.get(event.sessionId)
        dismissedSessionsRef.current.delete(event.sessionId)
        if (saved) {
          updateSessions(prev => {
            if (prev.find(s => s.id === saved.id)) return prev
            return [...prev, saved.imported ? saved : { ...saved, status: 'active' as const, lastActivityTime: Date.now() }]
          })
        }
      }
    })

    const unsubStatus = bridge.onStatus((status) => {
      setConnectionStatus(status)
    })

    const unsubConfig = bridge.onConfig((config) => {
      if (config.showMockData !== undefined) { setUseMockData(config.showMockData) }
      if (config.disable1MContext !== undefined) { setDisable1MContext(config.disable1MContext) }
      if (typeof config.hooksConfigured === 'boolean') { setHooksConfigured(config.hooksConfigured) }
    })

    // Session lifecycle: one handler per message type (lib/bridge-session-handlers). They only update the
    // session list and the selection; event flushing is the consumer's (index.tsx layout effect).
    const sessionCtx: SessionHandlerCtx = {
      updateSessions, selectedSessionIdRef, setSelectedSessionId, sessionSwitchPendingRef, pendingEventsRef,
      sessionBuffersRef, allEventsRef, allBaseRef, lastEventAtRef, modelTrackerRef, teamTrackerRef, dismissedSessionsRef,
      setSessionModels, refreshTeamView, setSessionsWithActivity, pushNotice,
      bumpEventVersion: () => setEventVersion(v => v + 1),
      now: Date.now,
    }
    const unsubSession = bridge.onSession((type, data) => {
      const handle = SESSION_HANDLERS[type] as (ctx: SessionHandlerCtx, data: unknown) => void
      handle(sessionCtx, data)
    })

    return () => {
      unsubInit()
      unsubEvent()
      unsubStatus()
      unsubConfig()
      unsubSession()
    }
  }, [updateSessions, leaveDemo, pushNotice, refreshTeamView, matchesSelection, recomputeVisible])

  // The rule depends on the session list, the teams, the selection and the clock
  useEffect(() => { recomputeVisible() }, [sessions, teamView, selectedSessionId, recomputeVisible])
  useEffect(() => {
    const t = setInterval(recomputeVisible, VISIBILITY_TICK_MS)
    return () => clearInterval(t)
  }, [recomputeVisible])

  const consumeEvents = useCallback(() => {
    // Clear in-place so stale closures in animation callbacks
    // also see the cleared array (prevents multi-frame reprocessing)
    pendingEventsRef.current.length = 0
  }, [])

  const currentEventCount = useCallback((sessionId: string): number => {
    if (sessionId === ALL_SESSIONS_ID || parseTeamSelection(sessionId) !== null) return allBaseRef.current + allEventsRef.current.length
    return sessionEventCount(sessionBuffersRef.current, sessionId)
  }, [])

  /** Switch session selection. Does NOT flush events — call flushSessionEvents
   *  from useLayoutEffect after the simulation state has been saved/swapped. */
  const selectSession = useCallback((sessionId: string | null) => {
    // What the outgoing view consumed: events still queued (paused view) were never handed to the simulation
    const leaving = selectedSessionIdRef.current
    if (leaving && outgoingCursorRef.current === null) {
      const delivered = pendingEventsRef.current.length > 0 ? pendingCursorRef.current : currentEventCount(leaving)
      outgoingCursorRef.current = { id: leaving, cursor: delivered }
    }
    // Block event delivery to pending until the simulation state is swapped
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId === ALL_SESSIONS_ID) {
      // The union view shows every session: nothing is unseen any more
      setSessionsWithActivity(prev => (prev.size === 0 ? prev : new Set()))
    } else if (parseTeamSelection(sessionId) !== null) {
      // A team view shows the team's sessions: they are no longer unseen
      const ids = teamSessionIds(parseTeamSelection(sessionId)!, teamTrackerRef.current, sessionsRef.current)
      setSessionsWithActivity(prev => {
        if (![...ids].some(id => prev.has(id))) return prev
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    } else if (sessionId) {
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [currentEventCount])

  /** Flush buffered events for the selected session into pending.
   *  Must be called from useLayoutEffect AFTER simulation state is saved/swapped. */
  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    sessionSwitchPendingRef.current = false
    outgoingCursorRef.current = null
    pendingEventsRef.current.length = 0
    pendingCursorRef.current = fromIndex
    if (sessionId === ALL_SESSIONS_ID || parseTeamSelection(sessionId) !== null) {
      // fromIndex is an absolute position: subtract what the cap already trimmed.
      // A team selection takes the events of the team's sessions out of the same arrival-order buffer.
      const all = allEventsRef.current
      for (let i = Math.max(0, fromIndex - allBaseRef.current); i < all.length; i++) {
        // matchesSelection also applies the 'All' finished-sessions filter, so a flush and live delivery agree
        if (matchesSelection(sessionId, all[i].sessionId)) pendingEventsRef.current.push({ ...all[i], replayed: true })
      }
    } else {
      // Re-fed from the buffer: the wall-clock moment of these events is lost, so they count as history
      pendingEventsRef.current.push(...sessionEventsFrom(sessionBuffersRef.current, sessionId, fromIndex).map(e => ({ ...e, replayed: true })))
    }
    setEventVersion(v => v + 1)
  }, [matchesSelection])

  /** Events of the session the view has consumed (buffered ones still queued or received during a switch excluded) */
  const getSessionEventCount = useCallback((sessionId: string): number => {
    const outgoing = outgoingCursorRef.current
    return outgoing && outgoing.id === sessionId ? outgoing.cursor : currentEventCount(sessionId)
  }, [currentEventCount])

  const getSessionEvents = useCallback((sessionId: string) => {
    if (sessionId === ALL_SESSIONS_ID || parseTeamSelection(sessionId) !== null) return { events: [], droppedBefore: 0 }
    return sessionExportSlice(sessionBuffersRef.current, sessionId)
  }, [])
  const getBufferedEventCount = useCallback((sessionId: string): number => {
    if (sessionId === ALL_SESSIONS_ID || parseTeamSelection(sessionId) !== null) return 0
    return bufferedEventCount(sessionBuffersRef.current, sessionId)
  }, [])

  const dismissedSessionsRef = useRef<Map<string, SessionInfo>>(new Map())

  const removeSession = useCallback((sessionId: string) => {
    updateSessions(prev => {
      const session = prev.find(s => s.id === sessionId)
      if (session) { dismissedSessionsRef.current.set(sessionId, session) }
      return prev.filter(s => s.id !== sessionId)
    })
    // A removed session no longer needs its replay buffer (the selected one keeps it until deselected)
    if (selectedSessionIdRef.current !== sessionId) releaseSessionBuffer(sessionBuffersRef.current, sessionId)
    setSessionsWithActivity(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [updateSessions])

  const restoreSession = useCallback((sessionId: string): boolean => {
    const saved = dismissedSessionsRef.current.get(sessionId)
    if (!saved) return false
    dismissedSessionsRef.current.delete(sessionId)
    updateSessions(prev => (prev.some(s => s.id === saved.id) ? prev : [...prev, saved]))
    return true
  }, [updateSessions])

  const loadDemo = useCallback(() => { setUseMockData(true) }, [])

  const bridgeOpenFile = useCallback((filePath: string, line?: number) => {
    vscodeBridge?.openFile(filePath, line)
  }, [])

  const bridgeOpenTerminal = useCallback((sessionId: string) => {
    vscodeBridge?.openTerminal(sessionId)
  }, [])

  return {
    isVSCode,
    connectionStatus,
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    useMockData,
    disable1MContext,
    hooksConfigured,
    bridgeOpenFile,
    bridgeOpenTerminal,
    sessions: displaySessions,
    renameSession,
    selectedSessionId,
    selectedSessionIdRef,
    selectSession,
    flushSessionEvents,
    getSessionEventCount,
    getSessionEvents,
    getBufferedEventCount,
    isAllSelected: selectedSessionId === ALL_SESSIONS_ID,
    teams: teamView.teams,
    teamWorking: teamView.working,
    teamSummaries: teamView.summaries,
    teamMemberCounts: teamView.members,
    showFinished,
    setShowFinished,
    allViewSessionIds: visibility.ids,
    allViewKey: visibility.key,
    finishedSessionCount: visibility.finished,
    sessionsWithActivity,
    sessionModels,
    removeSession,
    restoreSession,
    loadDemo,
    relayPort,
    relayOrigin,
    relayScope,
    relayScopePending,
    relayScopeError,
    setRelayScope,
    relayUnreachable,
    connectionDetail: relayEnabled ? source.detail : null,
    reconnectAttempt: relayEnabled ? source.attempt : 0,
    relayLinkMode: source.mode,
    notice,
    launch,
    systemStats,
  }
}

// ─── Operator decisions (#240) ───────────────────────────────────────────────

/** waiting: can be answered; sending: a decision left this page; sent: the extension handed a decision to Claude Code */
export type PermissionRowState = 'waiting' | 'sending' | 'sent'

export interface PermissionRow {
  request: PermissionRequestMessage
  state: PermissionRowState
  /** The decision this page sent, when it sent one */
  action?: PermissionAction
  /**
   * A deny or redirect this page sent was seen applied (#387): after the extension said `sent`, a live tool_call_end
   * of that very call (same session, same non-null tool_use_id) ended in error, not cancelled. Never set otherwise.
   */
  applied?: boolean
}

/** One polite announcement; `id` changes at each one so the same text is announced again */
export type PermissionNotice =
  | { id: number; kind: 'sent'; request: PermissionRequestMessage }
  | { id: number; kind: 'applied'; request: PermissionRequestMessage; action: 'deny' | 'redirect' }
  | { id: number; kind: 'closed'; request: PermissionRequestMessage; outcome: string }
  | { id: number; kind: 'error'; reason: string; request?: PermissionRequestMessage }

export interface PermissionState {
  rows: readonly PermissionRow[]
  notice: PermissionNotice | null
  nextId: number
}

export type PermissionEvent =
  | PermissionBridgeMessage
  | { kind: 'decide'; nonce: string; action: PermissionAction }
  | { kind: 'dismiss'; nonce: string }
  /** The end of a tool call, seen live in the event stream (#387) */
  | { kind: 'tool-end'; sessionId: string; toolUseId: string; refused: boolean }

const EMPTY_PERMISSIONS: PermissionState = { rows: [], notice: null, nextId: 1 }

/** Sent rows kept on screen (oldest dropped); waiting rows are never dropped here, the extension ends them */
const MAX_SENT_PERMISSION_ROWS = 5

/** Refusals after which the request still waits for a decision; any other refusal means it is gone */
const STILL_WAITING_REASONS = new Set(['mismatch', 'message-required'])

type NoticeBody =
  | { kind: 'sent'; request: PermissionRequestMessage }
  | { kind: 'applied'; request: PermissionRequestMessage; action: 'deny' | 'redirect' }
  | { kind: 'closed'; request: PermissionRequestMessage; outcome: string }
  | { kind: 'error'; reason: string; request?: PermissionRequestMessage }

/** A refusal of one call (#387): a tool_call_end that names its call, ended in error and was not a user interrupt */
function observedToolEnd(e: AgentEvent): Extract<PermissionEvent, { kind: 'tool-end' }> | null {
  // History (replayed, imported) is not news: only what arrives live after the decision can show it was applied
  if (e.type !== 'tool_call_end' || e.replayed || e.imported || typeof e.sessionId !== 'string') return null
  const id = e.payload.toolUseId
  if (typeof id !== 'string' || !id) return null
  return { kind: 'tool-end', sessionId: e.sessionId, toolUseId: id, refused: e.payload.isError === true && e.payload.outcome !== 'cancelled' }
}

/**
 * What the panel shows of the waiting requests. Only the extension's messages move a row to `sent` or remove it:
 * a click only makes it `sending`. Nothing here ever says a decision was applied (docs/reading-the-ui.md).
 */
function reducePermissions(s: PermissionState, e: PermissionEvent): PermissionState {
  const find = (nonce: string | null) => (nonce === null ? undefined : s.rows.find(r => r.request.nonce === nonce))
  const announce = (n: NoticeBody) => ({ notice: { ...n, id: s.nextId } as PermissionNotice, nextId: s.nextId + 1 })
  const withRow = (nonce: string, next: PermissionRow | null): PermissionRow[] => {
    const rows = next
      ? s.rows.map(r => (r.request.nonce === nonce ? next : r))
      : s.rows.filter(r => r.request.nonce !== nonce)
    const sent = rows.filter(r => r.state === 'sent')
    return sent.length > MAX_SENT_PERMISSION_ROWS ? rows.filter(r => r !== sent[0]) : rows
  }

  switch (e.kind) {
    case 'request': {
      const row = find(e.request.nonce)
      if (!row) return { ...s, rows: [...s.rows, { request: e.request, state: 'waiting' }] }
      return row.state === 'waiting' ? { ...s, rows: withRow(e.request.nonce, { request: e.request, state: 'waiting' }) } : s
    }
    case 'decide': {
      const row = find(e.nonce)
      if (!row || row.state !== 'waiting') return s
      return { ...s, rows: withRow(e.nonce, { ...row, state: 'sending', action: e.action }) }
    }
    case 'tool-end': {
      if (!e.refused) return s
      const row = s.rows.find(r => r.state === 'sent' && !r.applied && (r.action === 'deny' || r.action === 'redirect')
        && r.request.toolUseId === e.toolUseId && r.request.sessionId === e.sessionId)
      if (!row || (row.action !== 'deny' && row.action !== 'redirect')) return s
      return { ...s, rows: withRow(row.request.nonce, { ...row, applied: true }), ...announce({ kind: 'applied', request: row.request, action: row.action }) }
    }
    case 'dismiss': {
      const row = find(e.nonce)
      if (!row || row.state !== 'sent') return s
      return { ...s, rows: withRow(e.nonce, null) }
    }
    case 'closed': {
      const row = find(e.nonce)
      if (!row || row.state === 'sent') return s
      if (e.outcome === 'sent') {
        return { ...s, rows: withRow(e.nonce, { ...row, state: 'sent' }), ...announce({ kind: 'sent', request: row.request }) }
      }
      return { ...s, rows: withRow(e.nonce, null), ...announce({ kind: 'closed', request: row.request, outcome: e.outcome }) }
    }
    case 'result': {
      const row = find(e.nonce)
      if (e.ok) {
        if (!row || row.state === 'sent') return s
        return { ...s, rows: withRow(row.request.nonce, { ...row, state: 'sent' }), ...announce({ kind: 'sent', request: row.request }) }
      }
      const reason = e.reason ?? 'unknown'
      if (!row) {
        // No request named: whatever this page was sending did not go through, it can be answered again
        const rows = e.nonce === null
          ? s.rows.map(r => (r.state === 'sending' ? { request: r.request, state: 'waiting' as const } : r))
          : s.rows
        return { ...s, rows, ...announce({ kind: 'error', reason }) }
      }
      if (row.state === 'sent') return s
      const rows = STILL_WAITING_REASONS.has(reason)
        ? withRow(row.request.nonce, { request: row.request, state: 'waiting' })
        : withRow(row.request.nonce, null)
      return { ...s, rows, ...announce({ kind: 'error', reason, request: row.request }) }
    }
  }
}

export interface PermissionRequestsResult {
  /** Inside VS Code: the only place the extension offers decisions (#240) */
  available: boolean
  rows: readonly PermissionRow[]
  notice: PermissionNotice | null
  /** A redirect needs its text; an empty one is not sent */
  decide: (nonce: string, action: PermissionAction, message?: string) => void
  dismiss: (nonce: string) => void
}

/**
 * Waiting permission requests of the VS Code extension (#240, PR 4). While mounted inside VS Code it declares the
 * decision surface (the extension holds requests only then) and withdraws it when unmounted or when the page
 * unloads. Outside VS Code it sends nothing and stays empty.
 */
export function usePermissionRequests(): PermissionRequestsResult {
  const [available, setAvailable] = useState(false)
  const stateRef = useRef<PermissionState>(EMPTY_PERMISSIONS)
  const [, setVersion] = useState(0)

  const apply = useCallback((e: PermissionEvent) => {
    const next = reducePermissions(stateRef.current, e)
    if (next === stateRef.current) return
    stateRef.current = next
    setVersion(v => v + 1)
  }, [])

  useEffect(() => vscodeBridge?.onInit(() => setAvailable(true)), [])

  useEffect(() => {
    if (!available || !vscodeBridge) return
    // Listen first: the extension answers the surface with the requests already waiting
    const off = vscodeBridge.onPermission(apply)
    // The event stream is read only for the end of a call a deny or redirect was sent for (#387)
    const offEvents = vscodeBridge.onEvent(event => {
      const end = observedToolEnd(event)
      if (end) apply(end)
    })
    const detach = vscodeBridge.attachPermissionSurface()
    return () => {
      detach()
      offEvents()
      off()
    }
  }, [available, apply])

  const decide = useCallback((nonce: string, action: PermissionAction, message?: string) => {
    const row = stateRef.current.rows.find(r => r.request.nonce === nonce)
    if (!row || row.state !== 'waiting' || !vscodeBridge) return
    // A redirect without a text is not sent at all: the extension would refuse it (message-required)
    const text = action === 'redirect' ? redirectMessage(message ?? '') : ''
    if (action === 'redirect' && !text) return
    // State first: a second click before the re-render finds the row 'sending' and sends nothing
    apply({ kind: 'decide', nonce, action })
    const { sessionId, toolUseId } = row.request
    vscodeBridge.sendPermissionDecision(action === 'redirect'
      ? { sessionId, toolUseId, nonce, action, message: text }
      : { sessionId, toolUseId, nonce, action })
  }, [apply])

  const dismiss = useCallback((nonce: string) => { apply({ kind: 'dismiss', nonce }) }, [apply])

  const s = stateRef.current
  return { available, rows: s.rows, notice: s.notice, decide, dismiss }
}
