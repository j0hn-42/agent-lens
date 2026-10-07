'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'
import { vscodeBridge, type ConnectionStatus, type AgentEvent, type SessionInfo, type BridgeNotice } from '@/lib/vscode-bridge'
import { SimulationEvent } from '@/lib/agent-types'

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
  /** Open a file in the VS Code editor */
  bridgeOpenFile: (filePath: string, line?: number) => void
  /** Known sessions from the extension */
  sessions: SessionInfo[]
  /** Currently selected session ID */
  selectedSessionId: string | null
  /** Select a session to view (does not flush events — call flushSessionEvents after state swap). */
  selectSession: (sessionId: string | null) => void
  /** Flush buffered events for a session into pending. Call from useLayoutEffect after state swap. */
  flushSessionEvents: (sessionId: string, fromIndex?: number) => void
  /** Get the current event count for a session (for save/restore) */
  getSessionEventCount: (sessionId: string) => number
  /** Ref to the currently selected session ID — updated synchronously, not via React state */
  selectedSessionIdRef: React.RefObject<string | null>
  /** True while the 'All' tab (union of every session) is selected */
  isAllSelected: boolean
  /** Session IDs that have received events while not selected */
  sessionsWithActivity: Set<string>
  /** Remove a session from the list */
  removeSession: (sessionId: string) => void
  /** Undo a removeSession call (re-adds the dismissed session). Returns true if it was restored. */
  restoreSession: (sessionId: string) => boolean
  /** Switch to the built-in demo scenario (empty-state "Load demo" action) */
  loadDemo: () => void
  /** Relay port when known (standalone mode), for user-facing messages */
  relayPort: string
  /** True after the relay SSE connection failed and until it reconnects */
  relayUnreachable: boolean
  /** Latest non-blocking notice (parse failure, session reset, relay state); consumers toast it */
  notice: BridgeNotice | null
}

const PARSE_NOTICE_INTERVAL_MS = 10_000

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
export function useVSCodeBridge(): BridgeHookResult {
  const [isVSCode, setIsVSCode] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [useMockData, setUseMockData] = useState(
    process.env.NEXT_PUBLIC_DEMO !== '0'
  )
  const [disable1MContext, setDisable1MContext] = useState(false)
  const pendingEventsRef = useRef<SimulationEvent[]>([])
  const [, setEventVersion] = useState(0) // trigger re-render on new events

  // Session state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const selectedSessionIdRef = useRef<string | null>(null)
  const sessionEventsRef = useRef<Map<string, SimulationEvent[]>>(new Map())
  /** Every event in arrival order (feeds the 'All' tab). `allBaseRef` counts events trimmed from its front,
   *  so positions stay absolute and survive the cap. */
  const allEventsRef = useRef<SimulationEvent[]>([])
  const allBaseRef = useRef(0)
  /** True while a session switch is pending (between auto-select and useLayoutEffect).
   *  Prevents the animation frame from processing events in the wrong simulation context. */
  const sessionSwitchPendingRef = useRef(false)
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())
  const [relayUnreachable, setRelayUnreachable] = useState(false)
  const [notice, setNotice] = useState<BridgeNotice | null>(null)
  const noticeIdRef = useRef(0)
  const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
  const pushNotice = useCallback((kind: BridgeNotice['kind'], message: string) => {
    setNotice({ id: ++noticeIdRef.current, kind, message })
  }, [])

  // Connect to standalone dev relay server via SSE when not in VS Code
  useEffect(() => {
    if (typeof window === 'undefined') return
    const bridge = vscodeBridge
    if (!bridge) return

    // Skip in VS Code — extension handles events via postMessage
    if (bridge.isVSCode) return

    // Connect to relay in dev mode or standalone CLI mode
    const isStandalone = process.env.AGENT_LENS_STANDALONE === '1'
    if (!isStandalone && (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DEMO !== '0')) {
      // No relay to wait for: unless the VS Code init message arrives, we are offline.
      const t = setTimeout(() => {
        setConnectionStatus(s => (s === 'connecting' && !bridge.isVSCode ? 'disconnected' : s))
      }, 1500)
      return () => clearTimeout(t)
    }

    setConnectionStatus('connecting')
    const es = new EventSource(relayPort ? `http://127.0.0.1:${relayPort}/events` : '/events')
    let wasDown = false
    let lastParseNotice = 0

    es.onopen = () => {
      setConnectionStatus('connected')
      setRelayUnreachable(false)
      setUseMockData(false)
      if (wasDown) {
        wasDown = false
        pushNotice('relay-up', 'Relay reconnected')
      }
    }
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        window.postMessage(data, '*')
      } catch {
        // Surface malformed relay payloads without spamming: at most one notice per interval
        const now = Date.now()
        if (now - lastParseNotice > PARSE_NOTICE_INTERVAL_MS) {
          lastParseNotice = now
          pushNotice('parse-error', 'Received malformed data from the relay; some events were skipped')
        }
      }
    }
    es.onerror = () => {
      setConnectionStatus('disconnected')
      setRelayUnreachable(true)
      if (!wasDown) {
        wasDown = true
        pushNotice('relay-down', relayPort ? `Relay unreachable on :${relayPort}` : 'Relay unreachable')
      }
    }

    return () => {
      es.close()
    }
  }, [pushNotice, relayPort])

  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge) { return }

    // Listen for bridge initialization (event-driven, no polling)
    const unsubInit = bridge.onInit(() => {
      setIsVSCode(true)
      setUseMockData(false)
    })

    // Listen for events — buffer by session, deliver to pending if session matches.
    // selectedSessionIdRef is updated synchronously (not via React state) so it's
    // always current even before React re-renders.
    const unsubEvent = bridge.onEvent((event: AgentEvent) => {
      const simEvent: SimulationEvent = {
        time: event.time,
        type: event.type as SimulationEvent['type'],
        payload: event.payload,
        sessionId: event.sessionId,
      }

      // Always buffer by session (for replay on session switch)
      if (event.sessionId) {
        const buf = sessionEventsRef.current.get(event.sessionId) || []
        buf.push(simEvent)
        sessionEventsRef.current.set(event.sessionId, buf)
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
      const matches = selected === ALL_SESSIONS_ID || (!!selected && event.sessionId === selected)
      if (selected && matches && !sessionSwitchPendingRef.current) {
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
          setSessions(prev => {
            if (prev.find(s => s.id === saved.id)) return prev
            return [...prev, { ...saved, status: 'active' as const, lastActivityTime: Date.now() }]
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
    })

    // Session lifecycle tracking
    // Note: these handlers only update session list + selection state.
    // Event flushing is handled by the consumer (index.tsx effect) to avoid
    // races between auto-flush here and save/restore logic there.
    const unsubSession = bridge.onSession((type, data) => {
      if (type === 'reset') {
        // Panel was reopened — clear all stale state (and tell the user, non-blocking)
        // A plain panel reopen is routine (sent on every 'ready'): only announce real resets.
        if (data !== 'panel-reopened') pushNotice('reset', 'Session view was reset')
        setSessions([])
        setSelectedSessionId(null)
        selectedSessionIdRef.current = null
        pendingEventsRef.current.length = 0
        sessionEventsRef.current.clear()
        allEventsRef.current = []
        allBaseRef.current = 0
        setSessionsWithActivity(new Set())
        dismissedSessionsRef.current.clear()
        setEventVersion(v => v + 1)
        return
      }
      if (type === 'list') {
        const sessionList = data as SessionInfo[]
        setSessions(sessionList)
        // Auto-select: prefer active sessions, then most recently active.
        // Only set selection — useLayoutEffect handles flushing events.
        if (!selectedSessionIdRef.current && sessionList.length > 0) {
          const sorted = [...sessionList].sort((a, b) => {
            const aActive = a.status === 'active' ? 1 : 0
            const bActive = b.status === 'active' ? 1 : 0
            if (aActive !== bActive) return bActive - aActive
            return b.lastActivityTime - a.lastActivityTime
          })
          const autoId = sorted[0].id
          sessionSwitchPendingRef.current = true
          pendingEventsRef.current.length = 0
          selectedSessionIdRef.current = autoId
          setSelectedSessionId(autoId)
        }
      } else if (type === 'started') {
        const session = data as SessionInfo
        setSessions(prev => {
          const existing = prev.find(s => s.id === session.id)
          if (existing) {
            // Session resumed after inactivity — mark active again
            return prev.map(s => s.id === session.id
              ? { ...s, status: 'active' as const, lastActivityTime: Date.now() }
              : s)
          }
          return [...prev, session]
        })
        if (selectedSessionIdRef.current) {
          // Never yank the user away from what they are watching: pulse the new tab instead.
          if (selectedSessionIdRef.current !== session.id && selectedSessionIdRef.current !== ALL_SESSIONS_ID) {
            setSessionsWithActivity(prev => {
              if (prev.has(session.id)) return prev
              const next = new Set(prev)
              next.add(session.id)
              return next
            })
          }
        } else {
          // Nothing selected yet: select the new session.
          // Set switch-pending flag to prevent the animation frame from processing
          // events in the wrong simulation state before useLayoutEffect swaps it.
          sessionSwitchPendingRef.current = true
          pendingEventsRef.current.length = 0
          selectedSessionIdRef.current = session.id
          setSelectedSessionId(session.id)
        }
      } else if (type === 'updated') {
        const { sessionId, label } = data as { sessionId: string; label: string }
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, label } : s
        ))
      } else if (type === 'ended') {
        const sessionId = data as string
        setSessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, status: 'completed' as const } : s
        ))
      }
    })

    return () => {
      unsubInit()
      unsubEvent()
      unsubStatus()
      unsubConfig()
      unsubSession()
    }
  }, [pushNotice])

  const consumeEvents = useCallback(() => {
    // Clear in-place so stale closures in animation callbacks
    // also see the cleared array (prevents multi-frame reprocessing)
    pendingEventsRef.current.length = 0
  }, [])

  /** Switch session selection. Does NOT flush events — call flushSessionEvents
   *  from useLayoutEffect after the simulation state has been saved/swapped. */
  const selectSession = useCallback((sessionId: string | null) => {
    // Block event delivery to pending until the simulation state is swapped
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    selectedSessionIdRef.current = sessionId
    setSelectedSessionId(sessionId)
    if (sessionId === ALL_SESSIONS_ID) {
      // The union view shows every session: nothing is unseen any more
      setSessionsWithActivity(prev => (prev.size === 0 ? prev : new Set()))
    } else if (sessionId) {
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  /** Flush buffered events for the selected session into pending.
   *  Must be called from useLayoutEffect AFTER simulation state is saved/swapped. */
  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    sessionSwitchPendingRef.current = false
    pendingEventsRef.current.length = 0
    if (sessionId === ALL_SESSIONS_ID) {
      // fromIndex is an absolute position: subtract what the cap already trimmed
      const all = allEventsRef.current
      for (let i = Math.max(0, fromIndex - allBaseRef.current); i < all.length; i++) pendingEventsRef.current.push(all[i])
    } else {
      const buffered = sessionEventsRef.current.get(sessionId) || []
      pendingEventsRef.current.push(...buffered.slice(fromIndex))
    }
    setEventVersion(v => v + 1)
  }, [])

  const getSessionEventCount = useCallback((sessionId: string): number => {
    if (sessionId === ALL_SESSIONS_ID) return allBaseRef.current + allEventsRef.current.length
    return sessionEventsRef.current.get(sessionId)?.length ?? 0
  }, [])

  const dismissedSessionsRef = useRef<Map<string, SessionInfo>>(new Map())

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const session = prev.find(s => s.id === sessionId)
      if (session) { dismissedSessionsRef.current.set(sessionId, session) }
      return prev.filter(s => s.id !== sessionId)
    })
    setSessionsWithActivity(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const restoreSession = useCallback((sessionId: string): boolean => {
    const saved = dismissedSessionsRef.current.get(sessionId)
    if (!saved) return false
    dismissedSessionsRef.current.delete(sessionId)
    setSessions(prev => (prev.some(s => s.id === saved.id) ? prev : [...prev, saved]))
    return true
  }, [])

  const loadDemo = useCallback(() => { setUseMockData(true) }, [])

  const bridgeOpenFile = useCallback((filePath: string, line?: number) => {
    vscodeBridge?.openFile(filePath, line)
  }, [])

  return {
    isVSCode,
    connectionStatus,
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    useMockData,
    disable1MContext,
    bridgeOpenFile,
    sessions,
    selectedSessionId,
    selectedSessionIdRef,
    selectSession,
    flushSessionEvents,
    getSessionEventCount,
    isAllSelected: selectedSessionId === ALL_SESSIONS_ID,
    sessionsWithActivity,
    removeSession,
    restoreSession,
    loadDemo,
    relayPort,
    relayUnreachable,
    notice,
  }
}
