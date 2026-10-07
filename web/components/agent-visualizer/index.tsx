"use client"

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from "react"
import { useAgentSimulation } from "@/hooks/use-agent-simulation"
import { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { useSelectionState } from "@/hooks/use-selection-state"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { AgentCanvas } from "./canvas"
import { ControlBar } from "./control-bar"
import { AgentDetailCard } from "./agent-detail-card"
import { GlassContextMenu } from "./glass-context-menu"
import { ToolDetailPopup } from "./tool-detail-popup"
import { DiscoveryDetailPopup } from "./discovery-detail-popup"
import { FileAttentionPanel } from "./file-attention-panel"
import { TimelinePanel } from "./timeline-panel"
import { AgentChatPanel } from "./chat-panel"
import { SessionTranscriptPanel } from "./session-transcript-panel"
import { OpenFileProvider } from "./tool-content-renderer"
import { stopPropagationHandlers } from "./shared-ui"
import { TimelineEvent, TIMING } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"

import { MOCK_DURATION } from "@/lib/mock-scenario"
import { MessageFeedPanel } from "./message-feed-panel"
import { TopBar } from "./top-bar"
import { totalAgentCost } from "@/lib/cost"
import { useAudioEffects } from "@/hooks/use-audio-effects"
import { useToasts } from "@/hooks/use-toasts"
import { useFocusReturn } from "@/hooks/use-focus-return"
import { ToastRegion } from "./toast-region"
import { ShortcutsDialog } from "./shortcuts-dialog"
import { PanelRegistryContext, type PanelEscapeHandler, type RegisterPanel } from "@/hooks/use-panel-registry"
import { FOCUS_RING, UNDO_SHORTCUT_KEY, buildAnnouncement, connectionDisplay, emptyStateChecklist, formatMissedEvents, runEscapeHandlers } from "@/lib/chrome-utils"

const SINGLE_KEY_SHORTCUTS_STORAGE_KEY = 'agent-flow:single-key-shortcuts'

type PanelId = 'files' | 'transcript' | 'cost' | 'timeline' | 'stats'

export function AgentVisualizer() {
  const bridge = useVSCodeBridge()

  const {
    frameRef,
    agents,
    toolCalls,
    particles,
    edges,
    discoveries,
    fileAttention,
    timelineEntries,
    currentTime,
    isPlaying,
    speed,
    maxTimeReached,
    conversations,
    play,
    pause,
    restart,
    setSpeed,
    seekToTime,
    updateAgentPosition,
    saveSnapshot,
    restoreSnapshot,
  } = useAgentSimulation({
    useMockData: bridge.useMockData,
    externalEvents: bridge.pendingEvents,
    onExternalEventsConsumed: bridge.consumeEvents,
    sessionFilter: bridge.selectedSessionId,
    // Pass the ref that's updated synchronously in session-started handler,
    // so the animation frame never uses a stale filter value.
    sessionFilterRef: bridge.selectedSessionIdRef,
    disable1MContext: bridge.disable1MContext,
  })

  const selection = useSelectionState({ agents, toolCalls, discoveries })
  const { toasts, push: pushToast, dismiss: dismissToast, runAction, runLatestAction, setPaused: setToastsPaused } = useToasts()
  // Confirm that an undo happened (also announced to screen readers through the toast live region)
  const runToastAction = useCallback((id: number) => {
    runAction(id)
    pushToast({ message: 'Undone', durationMs: 3000 })
  }, [runAction, pushToast])
  const undoLast = useCallback((): boolean => {
    const ran = runLatestAction()
    if (ran) pushToast({ message: 'Undone', durationMs: 3000 })
    return ran
  }, [runLatestAction, pushToast])
  const [showShortcuts, setShowShortcuts] = useState(false)
  const openShortcuts = useCallback(() => setShowShortcuts(true), [])
  const closeShortcuts = useCallback(() => setShowShortcuts(false), [])

  // Surface bridge notices (relay down/up, malformed data, session reset) as non-blocking toasts
  const lastNoticeIdRef = useRef(0)
  useEffect(() => {
    const n = bridge.notice
    if (!n || n.id === lastNoticeIdRef.current) return
    lastNoticeIdRef.current = n.id
    pushToast({ message: n.message, durationMs: n.kind === 'relay-down' ? 8000 : 5000 })
  }, [bridge.notice, pushToast])

  const [showStats, setShowStats] = useState(false)
  const [showHexGrid, setShowHexGrid] = useState(true)
  const [showCostOverlay, setShowCostOverlay] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [showFileAttention, setShowFileAttention] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)

  // Mutually exclusive panel toggling — opening one closes the others
  const toggleExclusivePanel = useCallback((panel: 'files' | 'transcript' | 'cost') => {
    setShowFileAttention(prev => panel === 'files' ? !prev : false)
    setShowTranscript(prev => panel === 'transcript' ? !prev : false)
    setShowCostOverlay(prev => panel === 'cost' ? !prev : false)
  }, [])
  const [zoomToFitTrigger, setZoomToFitTrigger] = useState(0)

  const [isReviewing, setIsReviewing] = useState(false)

  // Focus management: move focus into a panel when it opens, back to its trigger when it closes
  const filesPanelRef = useRef<HTMLDivElement>(null)
  const transcriptPanelRef = useRef<HTMLDivElement>(null)
  const timelinePanelRef = useRef<HTMLDivElement>(null)
  useFocusReturn(showFileAttention, filesPanelRef)
  useFocusReturn(showTranscript, transcriptPanelRef)
  useFocusReturn(showTimeline, timelinePanelRef)
  const { isMuted, seekingRef, handleToggleMute } = useAudioEffects(agents, toolCalls, isReviewing)

  // Auto-play on mount
  useEffect(() => {
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play])

  // Per-session state cache: save/restore simulation state on tab switch
  // so sessions stay up to date and switching is instant.
  // useLayoutEffect ensures restart happens synchronously before any animation
  // frame can consume and discard events from pendingEventsRef.
  const sessionCacheRef = useRef<Map<string, { snapshot: ReturnType<typeof saveSnapshot>; eventCount: number }>>(new Map())
  const prevSelectedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (bridge.selectedSessionId && bridge.selectedSessionId !== prevSelectedRef.current) {
      // Save outgoing session state (if any)
      if (prevSelectedRef.current !== null) {
        sessionCacheRef.current.set(prevSelectedRef.current, {
          snapshot: saveSnapshot(),
          eventCount: bridge.getSessionEventCount(prevSelectedRef.current),
        })
      }

      // Restore or cold-start the incoming session, then flush events.
      // Flushing happens HERE (after state swap) to prevent the animation
      // frame from processing events in the wrong simulation context.
      const cached = sessionCacheRef.current.get(bridge.selectedSessionId)
      if (cached) {
        restoreSnapshot(cached.snapshot)
        bridge.flushSessionEvents(bridge.selectedSessionId, cached.eventCount)
      } else {
        restart()
        bridge.flushSessionEvents(bridge.selectedSessionId)
      }

      prevSelectedRef.current = bridge.selectedSessionId
    }
  }, [bridge.selectedSessionId, restart, bridge.flushSessionEvents, saveSnapshot, restoreSnapshot, bridge.getSessionEventCount])

  // Timeline events — incremental: only processes new conversation messages
  const timelineCacheRef = useRef<{
    counts: Map<string, number>
    events: TimelineEvent[]
    idCounter: number
  }>({ counts: new Map(), events: [], idCounter: 0 })

  const timelineEvents = useMemo((): TimelineEvent[] => {
    const cache = timelineCacheRef.current
    let appended = false
    for (const [agentId, msgs] of conversations) {
      const prevLen = cache.counts.get(agentId) ?? 0
      if (msgs.length > prevLen) {
        for (let i = prevLen; i < msgs.length; i++) {
          const msg = msgs[i]
          cache.events.push({
            id: `event-${cache.idCounter++}`,
            type: msg.type === 'tool_call' ? 'tool_call' : msg.type === 'tool_result' ? 'tool_result' : 'message',
            label: msg.content.slice(0, 20),
            timestamp: msg.timestamp,
            nodeId: agentId,
          })
        }
        cache.counts.set(agentId, msgs.length)
        appended = true
      }
    }
    if (appended) cache.events.sort((a, b) => a.timestamp - b.timestamp)
    return cache.events
  }, [conversations])

  // Review mode: when in live mode and user pauses to scrub through history

  const announceReview = useCallback(() => {
    pushToast({ message: 'Review mode - press LIVE to resume', durationMs: 4000 })
  }, [pushToast])

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause()
      setIsReviewing(true)
      announceReview()
    } else {
      play()
    }
  }, [isPlaying, play, pause, announceReview])

  const handleEnterReview = useCallback(() => {
    pause()
    setIsReviewing(true)
    announceReview()
  }, [pause, announceReview])

  // Speed only applies in review mode: in live mode it would silently distort the time axis
  const setSpeedInReview = useCallback((value: number) => {
    if (isReviewing) setSpeed(value)
  }, [isReviewing, setSpeed])

  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleResumeLive = useCallback(() => {
    // Events that arrived while paused are still queued: report them instead of silently compressing them
    const missed = formatMissedEvents(bridge.pendingEvents.length)
    if (missed) pushToast({ message: `Resumed live: ${missed.replace(' while reviewing', '')}`, durationMs: 5000 })
    setIsReviewing(false)
    seekToTime(maxTimeReached)
    setZoomToFitTrigger(n => n + 1)
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; play() }, TIMING.resumeLiveDelayMs)
  }, [seekToTime, maxTimeReached, play, bridge.pendingEvents, pushToast])
  useEffect(() => () => { if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current) }, [])

  // "Clear history": keeps active agents, drops the scrubbable history. Undo restores a snapshot.
  const handleClearHistory = useCallback(() => {
    const snapshot = saveSnapshot()
    setIsReviewing(false)
    restart(true)
    pushToast({
      message: 'History cleared',
      actionLabel: 'Undo',
      onAction: () => restoreSnapshot(snapshot),
    })
  }, [restart, saveSnapshot, restoreSnapshot, pushToast])

  // Rebuild the canvas from the buffered events of the selected session (live mode)
  const handleReloadSessionEvents = useCallback(() => {
    const id = bridge.selectedSessionIdRef.current
    restart()
    if (id) bridge.flushSessionEvents(id)
  }, [restart, bridge.selectedSessionIdRef, bridge.flushSessionEvents])

  // Panel open-order stack (LIFO) so Escape closes the most recently opened panel first
  const panelStackRef = useRef<PanelId[]>([])
  useEffect(() => {
    const open: Record<PanelId, boolean> = {
      files: showFileAttention, transcript: showTranscript, cost: showCostOverlay,
      timeline: showTimeline, stats: showStats,
    }
    const stack = panelStackRef.current.filter(id => open[id])
    for (const id of Object.keys(open) as PanelId[]) {
      if (open[id] && !stack.includes(id)) stack.push(id)
    }
    panelStackRef.current = stack
  }, [showFileAttention, showTranscript, showCostOverlay, showTimeline, showStats])

  // Extra panels (e.g. the expandable message feed) join the Escape stack through this registry
  const extraPanelsRef = useRef<Array<{ id: string; onEscape: PanelEscapeHandler }>>([])
  const registerPanel = useCallback<RegisterPanel>((id, onEscape) => {
    const entry = { id, onEscape }
    extraPanelsRef.current = [...extraPanelsRef.current.filter(p => p.id !== id), entry]
    return () => { extraPanelsRef.current = extraPanelsRef.current.filter(p => p !== entry) }
  }, [])

  const closeTopPanel = useCallback((): boolean => {
    const top = panelStackRef.current[panelStackRef.current.length - 1]
    if (!top) return runEscapeHandlers(extraPanelsRef.current.map(p => p.onEscape))
    panelStackRef.current = panelStackRef.current.slice(0, -1)
    if (top === 'files') setShowFileAttention(false)
    else if (top === 'transcript') setShowTranscript(false)
    else if (top === 'cost') setShowCostOverlay(false)
    else if (top === 'timeline') setShowTimeline(false)
    else setShowStats(false)
    return true
  }, [])

  // "Enable single-key shortcuts" preference (WCAG 2.1.4), persisted in localStorage
  const [singleKeyShortcuts, setSingleKeyShortcuts] = useState(true)
  useEffect(() => {
    try {
      if (localStorage.getItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY) === 'false') setSingleKeyShortcuts(false)
    } catch { /* storage unavailable */ }
  }, [])
  const updateSingleKeyShortcuts = useCallback((enabled: boolean) => {
    setSingleKeyShortcuts(enabled)
    try { localStorage.setItem(SINGLE_KEY_SHORTCUTS_STORAGE_KEY, String(enabled)) } catch { /* storage unavailable */ }
  }, [])

  // Keyboard shortcuts
  const keyboardActions = useMemo(() => ({
    togglePlayPause: handlePlayPause,
    toggleFilePanel: () => toggleExclusivePanel('files'),
    toggleTranscript: () => toggleExclusivePanel('transcript'),
    toggleTimeline: () => { setShowTimeline(prev => !prev) },
    toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
    toggleStats: () => { setShowStats(prev => !prev) },
    toggleCostOverlay: () => toggleExclusivePanel('cost'),
    zoomToFit: () => { setZoomToFitTrigger(n => n + 1) },
    closeTopPanel,
    clearSelection: () => { selection.clearAllSelections() },
    toggleMute: handleToggleMute,
    setSpeed: setSpeedInReview,
    openShortcuts,
    undoLast,
    singleKeyEnabled: singleKeyShortcuts,
  }), [openShortcuts, undoLast, handlePlayPause, selection.clearAllSelections, setSpeedInReview, handleToggleMute, toggleExclusivePanel, closeTopPanel, singleKeyShortcuts])

  useKeyboardShortcuts(keyboardActions)

  const totalTokens = useMemo(() => {
    let sum = 0
    for (const a of agents.values()) sum += a.tokensUsed
    return sum
  }, [agents])

  const totalCost = useMemo(() => totalAgentCost(agents.values()), [agents])

  const selectedAgent = selection.selectedAgentId ? agents.get(selection.selectedAgentId) : null
  const selectedConversation = selection.selectedAgentId ? (conversations.get(selection.selectedAgentId) || []) : []

  // Session runtime — drives the assistant label (CLAUDE vs CODEX) in transcript panels
  const sessionRuntime = useMemo(() => {
    for (const a of agents.values()) {
      if (a.runtime === 'codex') return 'codex' as const
    }
    return 'claude' as const
  }, [agents])

  // Session-wide conversation (all agents merged chronologically)
  // Only compute when the transcript panel is visible to avoid O(n log n) sort every frame
  const sessionConversation = useMemo(() => {
    if (!showTranscript) return []
    const all = Array.from(conversations.values()).flat()
    return all.sort((a, b) => a.timestamp - b.timestamp)
  }, [conversations, showTranscript])

  // Context menu items
  const contextMenuItems = selection.contextMenu ? (
    selection.contextMenu.agentId ? [
      { label: '📊  Toggle Stats', onClick: () => setShowStats(prev => !prev) },
    ] : [
      { label: '🔍  Zoom to Fit', onClick: () => setZoomToFitTrigger(n => n + 1) },
      { label: '📊  Toggle Stats', onClick: () => setShowStats(prev => !prev) },
      { label: '⬡  Toggle Grid', onClick: () => setShowHexGrid(prev => !prev) },
      { label: '', onClick: () => {}, separator: true },
      { label: '⟲  Clear history', onClick: handleClearHistory },
      ...(!bridge.useMockData && bridge.selectedSessionId
        ? [{ label: '↻  Reload session events', onClick: handleReloadSessionEvents }]
        : []),
    ]
  ) : []

  const { removeSession, restoreSession, selectSession } = bridge
  const handleCloseSession = useCallback((id: string) => {
    const closed = bridge.sessions.find(s => s.id === id)
    const wasSelected = bridge.selectedSessionId === id
    const remaining = bridge.sessions.filter(s => s.id !== id)
    removeSession(id)
    if (wasSelected && remaining.length > 0) {
      selectSession(remaining[remaining.length - 1].id)
    }
    pushToast({
      message: `Session closed${closed ? `: ${closed.label}` : ''}`,
      actionLabel: 'Undo',
      durationMs: 5000,
      onAction: () => {
        if (restoreSession(id) && wasSelected) selectSession(id)
      },
      // The cached simulation state is only needed while undo is possible
      onExpire: () => { sessionCacheRef.current.delete(id) },
    })
  }, [bridge.sessions, bridge.selectedSessionId, removeSession, restoreSession, selectSession, pushToast])

  const openFile = useCallback((filePath: string, line?: number) => {
    bridge.bridgeOpenFile(filePath, line)
  }, [bridge])

  const isEmpty = agents.size === 0 && !bridge.useMockData

  const { activeAgentCount, doneAgentCount } = useMemo(() => {
    let done = 0
    for (const a of agents.values()) if (a.state === 'complete') done++
    return { activeAgentCount: agents.size - done, doneAgentCount: done }
  }, [agents])

  const connection = connectionDisplay(bridge.connectionStatus, bridge.useMockData)
  const selectedSessionLabel = bridge.sessions.find(s => s.id === bridge.selectedSessionId)?.label ?? null
  const announcement = buildAnnouncement({ connection, sessionLabel: selectedSessionLabel, isReviewing, isEmpty })
  const checklist = emptyStateChecklist({
    status: bridge.connectionStatus,
    relayPort: bridge.relayPort || undefined,
    sessionCount: bridge.sessions.length,
  })

  return (
    <PanelRegistryContext.Provider value={registerPanel}>
    <OpenFileProvider value={bridge.isVSCode ? openFile : null}>
    <div className="h-screen w-full relative overflow-hidden" style={{ background: COLORS.void }}>
      {/* Polite live region: connection, session, review mode and empty state changes */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      {/* Top bar: session tabs + info/controls (banner landmark; offset var --topbar-h is published for panels) */}
      <TopBar
        sessions={bridge.sessions}
        selectedSessionId={bridge.selectedSessionId}
        sessionsWithActivity={bridge.sessionsWithActivity}
        onSelectSession={bridge.selectSession}
        onCloseSession={handleCloseSession}
        isVSCode={bridge.isVSCode}
        connectionStatus={bridge.connectionStatus}
        isDemo={bridge.useMockData}
        activeAgentCount={activeAgentCount}
        doneAgentCount={doneAgentCount}
        totalTokens={totalTokens}
        totalCost={totalCost}
        showFileAttention={showFileAttention}
        showTranscript={showTranscript}
        showCostOverlay={showCostOverlay}
        showTimeline={showTimeline}
        isMuted={isMuted}
        onTogglePanel={toggleExclusivePanel}
        onToggleTimeline={() => setShowTimeline(prev => !prev)}
        onToggleMute={handleToggleMute}
        onOpenShortcuts={openShortcuts}
      />

      <main id="visualizer-main" aria-label="Agent visualizer" className="absolute inset-0">
      <h1 className="sr-only">Agent Lens</h1>

      {/* Empty state when no demo and no live data */}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center z-10 p-3 pointer-events-none">
          <div
            className="text-center max-w-[calc(100vw-24px)] pointer-events-auto"
            style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}
          >
            <div className="text-sm font-semibold" style={{ color: COLORS.textPrimary }}>Waiting for an agent session</div>
            <div className="mt-1 text-xs" style={{ color: COLORS.textMuted }}>Start a Claude Code or Codex session in the watched workspace to see activity</div>
            <ul className="mt-3 inline-block text-left text-xs space-y-1" style={{ color: COLORS.textMuted }}>
              {checklist.map(item => (
                <li key={item.id}>
                  <span aria-hidden="true" className="inline-block w-4" style={{ color: item.ok ? COLORS.complete : COLORS.error }}>{item.ok ? '✓' : '✗'}</span>
                  <span className="sr-only">{item.ok ? 'Done: ' : 'Not done: '}</span>
                  {item.label}
                  {item.detail && <span> ({item.detail})</span>}
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <button
                type="button"
                onClick={bridge.loadDemo}
                className={`min-h-6 min-w-6 px-3 py-1 rounded text-xs font-semibold ${FOCUS_RING}`}
                style={{ background: COLORS.holoBg10, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
              >
                Load demo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Canvas fills everything */}
      <AgentCanvas
        simulationRef={frameRef}
        selectedAgentId={selection.selectedAgentId}
        hoveredAgentId={selection.hoveredAgentId}
        showStats={showStats}
        showHexGrid={showHexGrid}
        zoomToFitTrigger={zoomToFitTrigger}
        pauseAutoFit={selection.contextMenu !== null}
        onAgentClick={selection.handleAgentClick}
        onAgentHover={selection.setHoveredAgentId}
        onAgentDrag={updateAgentPosition}
        onContextMenu={selection.handleContextMenu}
        onToolCallClick={selection.handleToolCallClick}
        selectedToolCallId={selection.selectedToolCallId}
        onDiscoveryClick={selection.handleDiscoveryClick}
        selectedDiscoveryId={selection.selectedDiscoveryId}
        showCostOverlay={showCostOverlay}
      />

      {/* Message feed panel (top-left) */}
      <MessageFeedPanel
        conversations={conversations}
        agents={agents}
        onAgentClick={selection.handleAgentClick}
        selectedAgentId={selection.selectedAgentId}
      />

      {/* Agent detail card (floating, tethered to node) */}
      {selectedAgent && selection.selectedAgentWorldPos && (
        <div {...stopPropagationHandlers}>
          <AgentDetailCard
            agent={selectedAgent}
            onClose={selection.clearAgent}
          />
        </div>
      )}

      {/* Tool call detail popup */}
      {selection.selectedToolData && selection.selectedToolScreenPos && (
        <div {...stopPropagationHandlers}>
          <ToolDetailPopup
            tool={selection.selectedToolData}
            position={selection.selectedToolScreenPos}
            onClose={selection.clearTool}
          />
        </div>
      )}

      {/* Discovery detail popup */}
      {selection.selectedDiscoveryData && selection.selectedDiscoveryScreenPos && (
        <div {...stopPropagationHandlers}>
          <DiscoveryDetailPopup
            discovery={selection.selectedDiscoveryData}
            agentName={agents.get(selection.selectedDiscoveryData.agentId)?.name}
            position={selection.selectedDiscoveryScreenPos}
            onClose={selection.clearDiscovery}
          />
        </div>
      )}

      {/* Chat panel (bottom-right, shown when agent selected) */}
      <AgentChatPanel
        visible={!!selectedAgent}
        agentName={selectedAgent?.name ?? ''}
        agentState={selectedAgent?.state ?? 'idle'}
        conversation={selectedConversation}
        runtime={selectedAgent?.runtime ?? sessionRuntime}
        onClose={selection.clearAgent}
      />

      {/* Context menu */}
      {selection.contextMenu && (
        <GlassContextMenu
          position={selection.contextMenu}
          items={contextMenuItems}
          onClose={() => selection.setContextMenu(null)}
        />
      )}

      {/* Floating control strip */}
      <ControlBar
        isPlaying={isPlaying}
        speed={speed}
        currentTime={currentTime}
        totalDuration={bridge.useMockData
          ? (isReviewing ? Math.max(maxTimeReached, currentTime) : MOCK_DURATION)
          : Math.max(maxTimeReached, currentTime)
        }
        onPlayPause={handlePlayPause}
        onRestart={handleClearHistory}
        onSpeedChange={setSpeedInReview}
        isDemo={bridge.useMockData}
        onSeek={(time) => {
          seekingRef.current = true
          pause()
          seekToTime(time)
          setZoomToFitTrigger(n => n + 1)
          if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
          resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; seekingRef.current = false }, TIMING.seekCompleteDelayMs)
        }}
        timelineEvents={timelineEvents}
        isReviewing={isReviewing}
        eventCount={timelineEvents.length}
        onEnterReview={handleEnterReview}
        onResumeLive={handleResumeLive}
      />

      {/* File attention panel (slide-in from right) */}
      <div ref={filesPanelRef} style={{ display: 'contents' }}>
        <FileAttentionPanel
          visible={showFileAttention}
          fileAttention={fileAttention}
          onClose={() => setShowFileAttention(false)}
          onOpenFile={bridge.isVSCode ? openFile : undefined}
        />
      </div>

      {/* Session transcript panel (slide-in from right) */}
      <div ref={transcriptPanelRef} style={{ display: 'contents' }}>
        <SessionTranscriptPanel
          visible={showTranscript}
          conversation={sessionConversation}
          runtime={sessionRuntime}
          onClose={() => setShowTranscript(false)}
        />
      </div>

      {/* Timeline panel (slide-in from bottom) */}
      <div ref={timelinePanelRef} style={{ display: 'contents' }}>
        <TimelinePanel
          visible={showTimeline}
          timelineEntries={timelineEntries}
          currentTime={currentTime}
          onClose={() => setShowTimeline(false)}
        />
      </div>

      <ToastRegion
        toasts={toasts}
        onAction={runToastAction}
        onDismiss={dismissToast}
        onPause={setToastsPaused}
        undoKey={singleKeyShortcuts ? UNDO_SHORTCUT_KEY : null}
      />
      </main>

      <ShortcutsDialog
        open={showShortcuts}
        onClose={closeShortcuts}
        singleKeyEnabled={singleKeyShortcuts}
        onSingleKeyEnabledChange={updateSingleKeyShortcuts}
      />
    </div>
    </OpenFileProvider>
    </PanelRegistryContext.Provider>
  )
}
