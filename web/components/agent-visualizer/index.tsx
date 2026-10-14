"use client"

import { useThemeVersion } from '@/lib/theme'
import { useState, useCallback, useMemo, useEffect, useRef } from "react"
import { useAgentSimulation } from "@/hooks/use-agent-simulation"
import { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { useSelectionState } from "@/hooks/use-selection-state"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { AgentCanvas } from "./canvas"
import { ControlBar } from "./control-bar"
import { fetchProjectContext } from "@/lib/project-context"
import { OpenFileProvider } from "./tool-content-renderer"
import { useUiPreferences } from "@/hooks/use-ui-preferences"
import { dockStore, SHEET_BREAKPOINT } from "@/lib/panel-layout"
import { TIMING, Z } from "@/lib/agent-types"
import { COLORS, SCENE } from "@/lib/colors"
import { computeSessionOffsets } from "@/hooks/simulation/stamp-time"
import { parseTeamSelection } from "@/lib/bridge-types"
import { selectionLabel } from "@/lib/session-tree"

import { IS_GUIDED_DEMO, MOCK_DURATION } from "@/lib/mock-scenario"
import { useChromeModes } from "@/hooks/use-chrome-modes"
import { useAttentionSummary } from "@/hooks/use-attention-summary"
import { useInspector } from "@/hooks/use-inspector"
import { useSessionActions } from "@/hooks/use-session-actions"
import { useScopeControls } from "@/hooks/use-scope-controls"
import { EmptyState } from "./empty-state"
import { SelectionOverlays } from "./selection-overlays"
import { PanelDock } from "./panel-dock"
import { usePanelsState } from "@/hooks/use-panels-state"
import { useTourController } from "@/hooks/use-tour-controller"
import { useSessionViewSwap } from "@/hooks/use-session-view-swap"
import { useTimelineEvents } from "@/hooks/use-timeline-events"
import { useReviewControls } from "@/hooks/use-review-controls"
import { GuidedTourCard } from "./guided-tour-card"
import { TourHighlight } from "./tour-highlight"
import { TourBridgeContext } from "./guided-tour-context"
import { ConversationPanel } from "./conversation-panel"
import { TopBar, FullscreenIcon } from "./top-bar"
import { ChromeAnnouncer, HiddenFinishedAnnouncer } from "./chrome-announcer"
import { HistoryLoadingIndicator } from "./history-loading-indicator"
import { useAudioEffects } from "@/hooks/use-audio-effects"
import { useToasts } from "@/hooks/use-toasts"
import { ToastRegion } from "./toast-region"
import { PermissionRequests } from "./permission-requests"
import { ShortcutsDialog } from "./shortcuts-dialog"
import { SettingsDialog } from "./settings-dialog"
import { CommandPalette } from "./command-palette"
import { buildPaletteItems } from "@/lib/command-palette"
import { PresentationSubtitle, PresentationBadge } from "./presentation-subtitle"
import { PanelRegistryContext } from "@/hooks/use-panel-registry"
import { listedAgents } from "@/lib/inactive-agents"
import { shiftPickPair, prunePairStore } from "@/lib/pair-filter-store"
import { detectedSessions } from "@/lib/session-model"
import { useFreshnessValue } from "@/hooks/use-freshness-clock"
import { UNDO_SHORTCUT_KEY, buildSessionMeta, buildSessionProjects, labelAgentsWithSession, createLabelledSimulationRef, connectionDisplay, agentActivityCounts } from "@/lib/chrome-utils"
import { FOCUS_RING } from "@/lib/focus-ring"
import { deriveSessionLinks } from "@/lib/session-links"

export function AgentVisualizer() {
  // Persisted UI state (#32): panels, grid, stats, cost overlay and the right dock width survive a reload.
  // Speed is deliberately not persisted; the Sessions panel is not in the schema.
  const uiPrefs = useUiPreferences()
  const { prefs, setPref, getPrefs } = uiPrefs
  // The project filter is also the project scope of the All view (#291)
  const bridge = useVSCodeBridge({ projectScope: prefs.sessionFilterProject })
  // A theme switch re-renders the whole tree so every COLORS-based inline style repaints
  useThemeVersion()

  // Review mode: when in live mode and user pauses to scrub through history.
  // Declared before the simulation: speed other than 1x only applies while reviewing.
  const [isReviewing, setIsReviewing] = useState(false)
  const isReviewingRef = useRef(false)
  isReviewingRef.current = isReviewing

  // Union views ('All' / team) put every session on one wall-clock axis (offsets in seconds per session)
  const sessionOffsetsRef = useRef<ReadonlyMap<string, number> | undefined>(undefined)
  sessionOffsetsRef.current = useMemo(() => computeSessionOffsets(bridge.sessions), [bridge.sessions])

  const sessionProjects = useMemo(() => buildSessionProjects(bridge.sessions), [bridge.sessions])

  // 'Hide inactive agents': on by default, persisted with the other UI preferences
  const hideInactive = prefs.hideInactive
  const updateHideInactive = useCallback((hide: boolean) => setPref('hideInactive', hide), [setPref])
  // The guided tour shows the idle and finished agents its steps talk about, without touching the preference
  // A copy of tour.active: the tour hook needs the simulation's seek, so it is created after useAgentSimulation
  const [tourShowsInactive, setTourShowsInactive] = useState(false)
  const hideInactiveShown = hideInactive && !tourShowsInactive

  const {
    frameRef,
    agents,
    toolCalls,
    particles,
    edges,
    discoveries,
    fileAttention,
    waste,
    timelineEntries,
    currentTime,
    isPlaying,
    speed,
    maxTimeReached,
    conversations,
    droppedEvents,
    droppedMessages,
    unattributed,
    foreignAttention,
    catchUp,
    links,
    teams,
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
    isReviewing,
    sessionOffsetsRef,
    sessionProjects,
    hideInactive: hideInactiveShown,
  })

  const selection = useSelectionState({ agents, toolCalls, discoveries })
  // Files panel: an agent key read as "name (session label)", the key itself when the agent is unknown
  const agentLabel = useCallback((key: string) => {
    const a = agents.get(key)
    return a ? `${a.name}${a.sessionLabel ? ` (session ${a.sessionLabel})` : ''}` : key
  }, [agents])
  const { toasts, push: pushToast, dismiss: dismissToast, runAction, runLatestAction, hasAction: hasUndoToast, setPaused: setToastsPaused } = useToasts()
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
  const [showSettings, setShowSettings] = useState(false)
  const openSettings = useCallback(() => setShowSettings(true), [])
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const [showPalette, setShowPalette] = useState(false)
  const openPalette = useCallback(() => setShowPalette(true), [])
  const closePalette = useCallback(() => setShowPalette(false), [])

  // Surface bridge notices (relay down/up, malformed data, session reset) as non-blocking toasts
  const lastNoticeIdRef = useRef(0)
  useEffect(() => {
    const n = bridge.notice
    if (!n || n.id === lastNoticeIdRef.current) return
    lastNoticeIdRef.current = n.id
    pushToast({ message: n.message, durationMs: n.kind === 'relay-down' ? 8000 : 5000 })
  }, [bridge.notice, pushToast])

  const panels = usePanelsState(uiPrefs)
  const {
    showStats, setShowStats, showHexGrid, setShowHexGrid, showCostOverlay, showTimeline, setShowTimeline,
    showFileAttention, setShowFileAttention, showSessions, setShowSessions, showConversation,
    showContext, setShowContext, showSystem, setShowSystem,
    toggleExclusivePanel, openConversation, closeConversation, closeTopPanel, registerPanel,
  } = panels

  // Relay origin for on-demand reads ('' = same origin, standalone app)
  const contextOrigin = bridge.relayPort ? `http://127.0.0.1:${bridge.relayPort}` : ''
  const fetchContext = useCallback(
    (id: string) => fetchProjectContext(contextOrigin, id),
    [contextOrigin],
  )

  const [zoomToFitTrigger, setZoomToFitTrigger] = useState(0)

  // Selected agent link (canvas edge between teammates); the link panel is mounted by the integration
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null)
  const handleLinkClick = useCallback((linkId: string) => {
    setSelectedLinkId(prev => (prev === linkId ? null : linkId))
  }, [])
  useEffect(() => {
    if (selectedLinkId && !links.has(selectedLinkId)) setSelectedLinkId(null)
  }, [links, selectedLinkId])

  const { isMuted, seekingRef, handleToggleMute } = useAudioEffects(agents, toolCalls, isReviewing)

  // ?scenario=guided only means the guided demo on the demo data: a relay or VS Code takes over from it
  const isGuidedDemo = IS_GUIDED_DEMO && bridge.useMockData
  // Auto-play on mount (not in the guided demo: the tour holds the scenario at each step's time)
  useEffect(() => {
    if (isGuidedDemo) return
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play, isGuidedDemo])

  const onReviewEnded = useCallback(() => {
    setIsReviewing(false)
    pushToast({ message: 'Review ended: session changed', durationMs: 4000 })
  }, [pushToast])
  const sessionCacheRef = useSessionViewSwap({ bridge, restart, saveSnapshot, restoreSnapshot, isReviewingRef, onReviewEnded })

  const timelineEvents = useTimelineEvents(conversations)

  const zoomToFit = useCallback(() => setZoomToFitTrigger(n => n + 1), [])
  const {
    handlePlayPause, handleEnterReview, setSpeedInReview, handleResumeLive, handleClearHistory, handleReloadSessionEvents, handleSeek,
  } = useReviewControls({
    sim: { isPlaying, maxTimeReached, play, pause, restart, setSpeed, seekToTime, saveSnapshot, restoreSnapshot },
    bridge, isReviewing, setIsReviewing, pushToast, seekingRef, zoomToFit,
  })

  // Focus sits in the agent card right after a selection, and the card handles Escape itself: route it through
  // the same order as the global handler so one Escape closes exactly one thing (newest panel first, then
  // the selection), instead of clearing the selection while the panel it opened stays.
  const { clearAgent } = selection
  const escapeFromDetailCard = useCallback(() => {
    if (!closeTopPanel()) clearAgent()
  }, [closeTopPanel, clearAgent])

  // "Enable single-key shortcuts" preference (WCAG 2.1.4), persisted with the other UI preferences
  const singleKeyShortcuts = prefs.singleKeyShortcuts
  const updateSingleKeyShortcuts = useCallback((enabled: boolean) => setPref('singleKeyShortcuts', enabled), [setPref])

  const {
    immersive, toggleFullscreen, exitFullscreenRef, fullscreenNote,
    presentation, presentationOn, presentationMasked, presentationSubtitle, presentationNote,
    closeTopPanelOrImmersiveOrPresentation,
  } = useChromeModes(agents, closeTopPanel)

  // Keyboard shortcuts
  const keyboardActions = useMemo(() => ({
    togglePlayPause: handlePlayPause,
    toggleFilePanel: () => toggleExclusivePanel('files'),
    toggleSessionList: () => { setShowSessions(prev => !prev) },
    toggleConversation: () => toggleExclusivePanel('conversation'),
    toggleTimeline: () => { setShowTimeline(prev => !prev) },
    toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
    toggleStats: () => { setShowStats(prev => !prev) },
    toggleContext: () => toggleExclusivePanel('context'),
    toggleSystem: () => { setShowSystem(prev => !prev) },
    toggleCostOverlay: () => toggleExclusivePanel('cost'),
    zoomToFit: () => { setZoomToFitTrigger(n => n + 1) },
    toggleFullscreen,
    togglePresentation: presentation.toggle,
    closeTopPanel: closeTopPanelOrImmersiveOrPresentation,
    clearSelection: () => { selection.clearAllSelections() },
    toggleMute: handleToggleMute,
    setSpeed: setSpeedInReview,
    openShortcuts,
    openPalette,
    undoLast,
    canUndo: hasUndoToast,
    singleKeyEnabled: singleKeyShortcuts,
  }), [openShortcuts, openPalette, undoLast, hasUndoToast, handlePlayPause, selection.clearAllSelections, setSpeedInReview, handleToggleMute, toggleExclusivePanel, closeTopPanelOrImmersiveOrPresentation, toggleFullscreen, presentation.toggle, singleKeyShortcuts])

  useKeyboardShortcuts(keyboardActions)

  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const { usage, attention, notifyRules, setNotifyRules, notifyState, toggleNotify, health, jumpToAttention } = useAttentionSummary({
    sim: { agents, unattributed, foreignAttention, conversations, droppedMessages, catchUp },
    agentsRef, bridge, selectAgent: selection.handleAgentClick,
  })
  const tokenUsage = usage.tokens
  const costUsage = usage.cost
  const totalTokens = usage.summary.sessionTokens
  const totalCost = usage.summary.sessionCost

  const inspector = useInspector(selection, { agents, conversations, droppedMessages, edges, fileAttention })

  // Per-agent chat is a preset of the Conversation panel: selecting an agent opens it on that agent's tab
  // (the panel follows `selectedAgentId`); the role label of each message comes from its agent's runtime.
  // Not on a narrow viewport (#116): panels are one-at-a-time sheets there and the newest wins, so opening
  // Conversation right after the card would hide the inspector (and closing it would drop the selection).
  useEffect(() => {
    if (selection.selectedAgentId && dockStore.getSnapshot().env.viewport.w >= SHEET_BREAKPOINT) openConversation()
  }, [selection.selectedAgentId, openConversation])

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

  const { selectSession } = bridge

  const sessionActions = useSessionActions({ bridge, uiPrefs, pushToast, sessionCacheRef })

  const openFile = useCallback((filePath: string, line?: number) => {
    bridge.bridgeOpenFile(filePath, line)
  }, [bridge])

  // Halo titles (session label, runtime, workspace, status) come from the session list
  const sessionMeta = useMemo(() => buildSessionMeta(bridge.sessions), [bridge.sessions])
  const sessionLinks = useMemo(() => deriveSessionLinks(bridge.sessions), [bridge.sessions])
  // Permission requests (#240) name their session with the label of the list when it has one
  const permissionSessionLabel = useCallback(
    (id: string) => bridge.sessions.find(s => s.id === id)?.label,
    [bridge.sessions],
  )
  // Pair filter: Shift-click on an agent picks it as one end of the pair, a plain click keeps selecting
  const { handleAgentClick: selectAgent } = selection
  const selectedAgentIdForPair = selection.selectedAgentId
  const handleCanvasAgentClick = useCallback((agentId: string | null, modifiers?: { shiftKey: boolean }) => {
    if (modifiers?.shiftKey && agentId) {
      // Picking must not change the selection: the feed clears the pair whenever the selected agent
      // changes (the tab would no longer describe the list), which would wipe the pair just chosen.
      shiftPickPair(selectedAgentIdForPair, agentId)
      return
    }
    selectAgent(agentId)
  }, [selectAgent, selectedAgentIdForPair])
  // An agent that left the simulation cannot stay in the pair
  useEffect(() => { prunePairStore(key => agents.has(key)) }, [agents])

  // The canvas draws from the simulation ref: hand it agents that carry their session label and runtime
  const sessionsForCanvasRef = useRef(bridge.sessions)
  sessionsForCanvasRef.current = bridge.sessions
  const labelledSimulationRef = useMemo(
    () => createLabelledSimulationRef(frameRef, () => sessionsForCanvasRef.current),
    [frameRef],
  )

  // Team props are spread so each panel picks the ones it declares
  const canvasTeamProps = {
    links, teams, onLinkClick: handleLinkClick, selectedLinkId, scopeKey: bridge.selectedSessionId ?? '',
    sessions: sessionMeta, onClusterSelect: sessionActions.handleClusterSelect, sessionLinks,
  }
  const feedTeamProps = { links, droppedMessages, teams }

  const isEmpty = agents.size === 0 && !bridge.useMockData

  // Agents whose status is older than the freshness limit are counted apart: they are not "active" any more (#145)
  const countsKey = useFreshnessValue(now => {
    const c = agentActivityCounts(agentsRef.current.values(), now)
    return `${c.active}|${c.done}|${c.stale}`
  })
  const { activeAgentCount, doneAgentCount, staleAgentCount } = useMemo(() => {
    const [active, done, stale] = countsKey.split('|').map(Number)
    return { activeAgentCount: active, doneAgentCount: done, staleAgentCount: stale }
  }, [countsKey, agents])

  // 'All' counts only the sessions it shows (all of them while finished ones are included)
  const allSessionCount = useMemo(() => {
    const ids = bridge.allViewSessionIds
    return detectedSessions(bridge.sessions).filter(s => !ids || ids.has(s.id)).length
  }, [bridge.allViewSessionIds, bridge.sessions])

  const connection = connectionDisplay(bridge.connectionStatus, bridge.useMockData)
  const selectedTeam = parseTeamSelection(bridge.selectedSessionId)
  const selectedSessionLabel = bridge.isAllSelected
    ? 'All sessions'
    : selectedTeam !== null
      ? selectionLabel(bridge.selectedSessionId, bridge.sessions, bridge.teams)
      : bridge.sessions.find(s => s.id === bridge.selectedSessionId)?.label ?? null

  // Agents labelled with their session (label + runtime) so the feed can show a session chip
  const hiddenKeepIds = useMemo(() => [selection.selectedAgentId], [selection.selectedAgentId])
  // Same finished agents as the canvas and the DOM mirror (#147): the sessions list must not show what is announced hidden
  const listAgents = useMemo(() => listedAgents(agents, hideInactiveShown, hiddenKeepIds), [agents, hideInactiveShown, hiddenKeepIds])
  const labelledAgents = useMemo(() => labelAgentsWithSession(agents, bridge.sessions), [agents, bridge.sessions])
  // Command palette (#243): built only while it is open, from the lists the panels already show
  const paletteItems = useMemo(() => {
    if (!showPalette) return []
    return buildPaletteItems({
      singleKeyEnabled: singleKeyShortcuts,
      selectedSessionId: bridge.selectedSessionId,
      sessions: bridge.sessions,
      agents: listAgents.values(),
      actions: {
        togglePlayPause: handlePlayPause,
        zoomToFit: () => { setZoomToFitTrigger(n => n + 1) },
        toggleFullscreen,
        toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
        toggleMute: handleToggleMute,
        openShortcuts,
        openSettings,
      },
      togglePanel: panel => {
        if (panel === 'sessions') setShowSessions(prev => !prev)
        else if (panel === 'timeline') setShowTimeline(prev => !prev)
        else if (panel === 'stats') setShowStats(prev => !prev)
        else if (panel === 'system') setShowSystem(prev => !prev)
        else toggleExclusivePanel(panel)
      },
      selectSession,
      selectAgent: selection.handleAgentClick,
    })
  }, [showPalette, singleKeyShortcuts, bridge.selectedSessionId, bridge.sessions, listAgents, handlePlayPause, toggleFullscreen,
    setShowHexGrid, handleToggleMute, openShortcuts, openSettings, setShowTimeline, setShowStats, toggleExclusivePanel, selectSession, selection.handleAgentClick])
  const scopeProps = useScopeControls(bridge, uiPrefs)

  const { tour, steps: tourSteps, tourBridge, tourStale, getTourAgents, exitTour } = useTourController({
    seek: handleSeek, play, isGuidedDemo, frameRef, setTourShowsInactive,
  })

  return (
    <PanelRegistryContext.Provider value={registerPanel}>
    <TourBridgeContext.Provider value={tourBridge}>
    <OpenFileProvider value={bridge.isVSCode ? openFile : null}>
    <div className="h-screen w-full relative overflow-hidden" style={{ background: SCENE.void }}>
      {/* Polite live region: connection, session, review mode and empty state changes */}
      <ChromeAnnouncer
        connection={connection} sessionLabel={selectedSessionLabel} isReviewing={isReviewing} isEmpty={isEmpty}
        sessions={bridge.sessions} sessionsWithActivity={bridge.sessionsWithActivity} fullscreenNote={fullscreenNote} presentationNote={presentationNote}
      />

      <HiddenFinishedAnnouncer agents={agents} hideInactive={hideInactiveShown} keepIds={hiddenKeepIds} />

      {/* Burst of received events being caught up over several frames (#210) */}
      <HistoryLoadingIndicator progress={catchUp} />

      {/* Top bar: sessions button + info/controls (banner landmark; offset var --topbar-h is published for panels) */}
      <div style={{ display: immersive ? 'none' : 'contents' }}>
      <TopBar
        onToggleFullscreen={toggleFullscreen}
        sessions={bridge.sessions}
        teams={bridge.teams}
        allSessionCount={allSessionCount}
        showFinished={bridge.showFinished}
        finishedSessionCount={bridge.finishedSessionCount}
        onToggleShowFinished={bridge.setShowFinished}
        hideInactive={hideInactive}
        onToggleHideInactive={updateHideInactive}
        selectedSessionId={bridge.selectedSessionId}
        sessionsWithActivity={bridge.sessionsWithActivity}
        showSessions={showSessions}
        onToggleSessions={() => setShowSessions(prev => !prev)}
        isVSCode={bridge.isVSCode}
        connectionStatus={bridge.connectionStatus}
        scope={bridge.relayOrigin !== null ? scopeProps : undefined}
        isDemo={bridge.useMockData}
        activeAgentCount={activeAgentCount}
        staleAgentCount={staleAgentCount}
        doneAgentCount={doneAgentCount}
        totalTokens={totalTokens}
        totalCost={totalCost}
        tokenUsage={tokenUsage}
        costUsage={costUsage}
        unattributedCost={usage.summary.unattributedCost}
        showFileAttention={showFileAttention}
        showConversation={showConversation}
        showContext={showContext}
        showSystem={showSystem}
        showCostOverlay={showCostOverlay}
        showTimeline={showTimeline}
        isMuted={isMuted}
        showStats={showStats}
        onToggleStats={() => setShowStats(prev => !prev)}
        onTogglePanel={panel => (panel === 'system' ? setShowSystem(prev => !prev) : toggleExclusivePanel(panel))}
        onToggleTimeline={() => setShowTimeline(prev => !prev)}
        onToggleMute={handleToggleMute}
        onOpenShortcuts={openShortcuts}
        onOpenSettings={openSettings}
        attention={attention}
        onJumpToAttention={jumpToAttention}
        notifyState={notifyState}
        onToggleNotify={toggleNotify}
      />
      </div>

      {presentationOn && <PresentationBadge onStop={presentation.stop} />}
      <PresentationSubtitle text={presentationSubtitle} />

      {immersive && (
        <button
          ref={exitFullscreenRef}
          type="button"
          onClick={toggleFullscreen}
          aria-label="Exit full screen"
          title="Exit full screen (Z)"
          className={`fixed top-2 right-2 rounded-md p-2 ${FOCUS_RING}`}
          // Drawn on the scene ground, so scene colours (>= 3:1 for the icon and the outline) whatever the theme
          style={{ zIndex: Z.controlBar + 1, background: 'var(--lens-scrim)', color: SCENE.textPrimary, border: `1px solid ${SCENE.textPrimary}` }}
        >
          <FullscreenIcon exit />
        </button>
      )}

      <main id="visualizer-main" aria-label="Agent visualizer" className="absolute inset-0">
      <h1 className="sr-only">Agent Lens</h1>

      {isEmpty && <EmptyState bridge={bridge} />}

      {/* Canvas fills everything */}
      <AgentCanvas
        {...canvasTeamProps}
        simulationRef={labelledSimulationRef}
        selectedAgentId={selection.selectedAgentId}
        hoveredAgentId={selection.hoveredAgentId}
        showStats={showStats}
        showHexGrid={showHexGrid}
        zoomToFitTrigger={zoomToFitTrigger}
        pauseAutoFit={selection.contextMenu !== null}
        onAgentClick={handleCanvasAgentClick}
        onAgentHover={selection.setHoveredAgentId}
        onAgentDrag={updateAgentPosition}
        onContextMenu={selection.handleContextMenu}
        onToolCallClick={selection.handleToolCallClick}
        selectedToolCallId={selection.selectedToolCallId}
        onDiscoveryClick={selection.handleDiscoveryClick}
        selectedDiscoveryId={selection.selectedDiscoveryId}
        showCostOverlay={showCostOverlay}
        hideInactive={hideInactiveShown}
        presentation={{ follow: presentationOn && presentation.options.follow, mask: presentationMasked }}
      />

      {/* Conversation: collapsed pill (top-left) or open panel (right dock), filtered to the selected agent */}
      <ConversationPanel
        {...feedTeamProps}
        open={showConversation}
        onOpen={openConversation}
        onClose={closeConversation}
        conversations={conversations}
        agents={labelledAgents}
        onAgentClick={selection.handleAgentClick}
        selectedAgentId={selection.selectedAgentId}
      />

      <SelectionOverlays
        selection={selection} inspector={inspector} agents={agents} links={links} droppedMessages={droppedMessages}
        health={health} bridge={bridge} selectedLinkId={selectedLinkId} onCloseLink={() => setSelectedLinkId(null)}
        onEscapeFromCard={escapeFromDetailCard} contextMenuItems={contextMenuItems}
      />

      {/* Floating control strip */}
      <div style={{ display: immersive ? 'none' : 'contents' }}>
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
        connectionStatus={bridge.connectionStatus}
        onSeek={handleSeek}
        timelineEvents={timelineEvents}
        isReviewing={isReviewing}
        eventCount={timelineEvents.length}
        onEnterReview={handleEnterReview}
        onResumeLive={handleResumeLive}
        droppedEvents={droppedEvents}
      />
      </div>

      <PanelDock
        panels={panels} sim={{ fileAttention, waste, agents, timelineEntries, currentTime }} bridge={bridge} selection={selection}
        attention={attention} health={health} sessionActions={sessionActions} uiPrefs={uiPrefs} allSessionCount={allSessionCount}
        listAgents={listAgents} agentLabel={agentLabel} openFile={openFile} fetchContext={fetchContext} contextOrigin={contextOrigin}
      />

      {tour.active && tour.step && (
        <>
          <TourHighlight key={tour.step.id} target={tour.step.target} getAgents={getTourAgents} />
          <GuidedTourCard steps={tourSteps} index={tour.index} stale={tourStale} onNext={tour.next} onPrev={tour.prev} onGoTo={tour.goTo} onExit={exitTour} />
        </>
      )}

      <ToastRegion
        toasts={toasts}
        onAction={runToastAction}
        onDismiss={dismissToast}
        onPause={setToastsPaused}
        undoKey={singleKeyShortcuts ? UNDO_SHORTCUT_KEY : null}
      />
      {/* Operator decisions (#240): renders nothing outside VS Code */}
      <PermissionRequests sessionLabel={permissionSessionLabel} />
      </main>

      <SettingsDialog
        open={showSettings}
        onClose={closeSettings}
        hexGrid={showHexGrid}
        onHexGridChange={setShowHexGrid}
        muted={isMuted}
        onToggleMute={handleToggleMute}
        showFinished={bridge.showFinished}
        onShowFinishedChange={bridge.setShowFinished}
        hideInactive={hideInactive}
        onHideInactiveChange={updateHideInactive}
        singleKeyEnabled={singleKeyShortcuts}
        onSingleKeyEnabledChange={updateSingleKeyShortcuts}
        onOpenShortcuts={openShortcuts}
        presentation={{ active: presentationOn, onActiveChange: v => presentation.setActive(v), options: presentation.options, onOptionChange: presentation.setOption }}
        notifications={{ state: notifyState, onToggle: toggleNotify, rules: notifyRules, onRulesChange: setNotifyRules }}
      />

      <CommandPalette open={showPalette} onClose={closePalette} items={paletteItems} />

      <ShortcutsDialog
        open={showShortcuts}
        onClose={closeShortcuts}
        singleKeyEnabled={singleKeyShortcuts}
        onSingleKeyEnabledChange={updateSingleKeyShortcuts}
      />
    </div>
    </OpenFileProvider>
    </TourBridgeContext.Provider>
    </PanelRegistryContext.Provider>
  )
}
