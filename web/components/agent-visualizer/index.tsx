"use client"

import { useThemeVersion } from '@/lib/theme'
import { visibleSettingsTabs } from '@/lib/settings-tabs'
import { useState, useCallback, useRef, useMemo, useEffect } from "react"
import { useAgentSimulation } from "@/hooks/use-agent-simulation"
import { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { useSelectionState } from "@/hooks/use-selection-state"
import { AgentCanvas } from "./canvas"
import { ControlBar } from "./control-bar"
import { fetchProjectContext } from "@/lib/project-context"
import { OpenFileProvider } from "./tool-content-renderer"
import { useUiPreferences } from "@/hooks/use-ui-preferences"
import { hidesInactiveAgents, type ShowMode } from "@/lib/show-mode"
import type { AnnounceLevel } from "@/lib/ui-preferences"
import { Z } from "@/lib/agent-types"
import { COLORS, SCENE } from "@/lib/colors"

import { IS_GUIDED_DEMO, MOCK_DURATION } from "@/lib/mock-scenario"
import { useChromeModes } from "@/hooks/use-chrome-modes"
import { useAttentionSummary } from "@/hooks/use-attention-summary"
import { useInspector } from "@/hooks/use-inspector"
import { useSessionActions } from "@/hooks/use-session-actions"
import { useScopeControls } from "@/hooks/use-scope-controls"
import { EmptyState } from "./empty-state"
import { SelectionOverlays } from "./selection-overlays"
import { PanelDock } from "./panel-dock"
import { VisualizerDialogs } from "./visualizer-dialogs"
import { useToastCenter } from "@/hooks/use-toast-center"
import { useDialogsState } from "@/hooks/use-dialogs-state"
import { useCanvasSelection } from "@/hooks/use-canvas-selection"
import { useVisualizerShortcuts } from "@/hooks/use-visualizer-shortcuts"
import { FOCUSABLE } from "@/hooks/use-focus-return"
import { useChromeData } from "@/hooks/use-chrome-data"
import { usePaletteItems } from "@/hooks/use-palette-items"
import { usePanelsState } from "@/hooks/use-panels-state"
import { useTourController } from "@/hooks/use-tour-controller"
import { quotaStreamActive } from "@/lib/quota"
import { useSessionViewSwap } from "@/hooks/use-session-view-swap"
import { useVisualizerSimulation } from "@/hooks/use-visualizer-simulation"
import { useTimelineEvents } from "@/hooks/use-timeline-events"
import { useReviewControls } from "@/hooks/use-review-controls"
import { GuidedTourCard } from "./guided-tour-card"
import { TourOffer } from "./tour-offer"
import { useTourOffer } from "@/hooks/use-tour-offer"
import { TourHighlight } from "./tour-highlight"
import { TourBridgeContext } from "./guided-tour-context"
import { ConversationPanel } from "./conversation-panel"
import { TopBar, FullscreenIcon, PANEL_BUTTON_IDS } from "./top-bar"
import { ChromeAnnouncer, HiddenFinishedAnnouncer } from "./chrome-announcer"
import { HistoryLoadingIndicator } from "./history-loading-indicator"
import { CostTotalsText } from "./cost-totals-text"
import { TruncationBanner, TruncationAnnouncer, TruncationIndicator } from "./truncation-banner"
import {
  truncationBannerState, replayLostForAgents, usageUnderLoss, truncationDismissKey, readTruncationDismissals, writeTruncationDismissals,
  tabStorage, dismissTruncation, allViewSessionTotals, viewNormalizationStats,
} from "@/lib/event-loss"
import { useAudioEffects } from "@/hooks/use-audio-effects"
import { ToastRegion } from "./toast-region"
import { PermissionRequests } from "./permission-requests"
import { PresentationSubtitle, PresentationBadge } from "./presentation-subtitle"
import { PanelRegistryContext } from "@/hooks/use-panel-registry"
import { HiddenFinishedNotice } from "./hidden-finished-notice"
import { UnderTopbarStack } from "./hidden-panels-notice"
import { UNDO_SHORTCUT_KEY } from "@/lib/chrome-utils"
import { FOCUS_RING } from "@/lib/focus-ring"

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
  /**
   * Per view (truncationDismissKey): the total when the user dismissed the truncation banner (it returns when more is
   * lost, or, with the relay's figure, at a lower total after a relay restart: truncationBannerState). Kept for the tab in
   * sessionStorage (#567), so a reload or a relaunch in the same tab does not show it again. Only a user gesture writes it.
   */
  const [truncationDismissed, setTruncationDismissed] = useState<Map<string, number>>(() => readTruncationDismissals(tabStorage()))
  /**
   * The view whose banner the indicator reopened, and how many times: remounts the banner with its details open.
   * `focus`: the focus request of that reopen, not yet spent by the banner.
   */
  const [truncationReopened, setTruncationReopened] = useState<{ key: string; n: number; focus: boolean } | null>(null)
  const isReviewingRef = useRef(false)
  isReviewingRef.current = isReviewing

  // 'Show: active / all' (#372): one mode, 'active' by default, persisted with the other UI preferences. 'active' hides
  // the inactive agents here and the finished sessions in the bridge (it reads the same field)
  const showMode = prefs.show
  const hideInactive = hidesInactiveAgents(showMode)
  const updateShowMode = useCallback((mode: ShowMode) => setPref('show', mode), [setPref])
  // #372: Settings > General opens the View popover of the canvas controls; each press raises the counter once
  const [viewControlsRequest, setViewControlsRequest] = useState(0)
  const openViewControls = useCallback(() => setViewControlsRequest(n => n + 1), [])
  // Quota gauges of the top bar (#467): the runtime of the selected session decides what they say (undefined = none selected)
  const showQuota = prefs.showQuota
  const updateShowQuota = useCallback((show: boolean) => setPref('showQuota', show), [setPref])
  const selectedRuntime = bridge.sessions.find(sess => sess.id === bridge.selectedSessionId)?.runtime
  const updateAnnounceLevel = useCallback((level: AnnounceLevel) => setPref('announceLevel', level), [setPref])
  // The guided tour shows the idle and finished agents its steps talk about, without touching the preference
  // A copy of tour.active: the tour hook needs the simulation's seek, so it is created after useAgentSimulation
  const [tourShowsInactive, setTourShowsInactive] = useState(false)
  const hideInactiveShown = hideInactive && !tourShowsInactive

  const {
    frameRef, agents, toolCalls, edges, discoveries, fileAttention, waste, timelineEntries, currentTime, isPlaying, speed, maxTimeReached,
    conversations, droppedEvents, droppedMessages, normalizationStats, unattributed, foreignAttention, catchUp, links, teams,
    play, pause, restart, setSpeed, seekToTime, updateAgentPosition, setLayoutKeepIds, saveSnapshot, restoreSnapshot,
  } = useVisualizerSimulation(bridge, isReviewing, hideInactiveShown)

  const selection = useSelectionState({ agents, toolCalls, discoveries })
  // Files panel: an agent key read as "name (session label)", the key itself when the agent is unknown
  const agentLabel = useCallback((key: string) => {
    const a = agents.get(key)
    return a ? `${a.name}${a.sessionLabel ? ` (session ${a.sessionLabel})` : ''}` : key
  }, [agents])
  const { toasts, pushToast, dismissToast, runToastAction, undoLast, setToastsPaused } = useToastCenter(bridge.notice)
  const { showShortcuts, openShortcuts, closeShortcuts, showSettings, openSettings, openSettingsTab, closeSettings, settingsTab, setSettingsTab, showPalette, openPalette, closePalette } = useDialogsState()

  const panels = usePanelsState(uiPrefs, selection.selectedAgentId)
  const {
    showStats, setShowStats, showHexGrid, setShowHexGrid, showCostOverlay, showTimeline, setShowTimeline,
    showFileAttention, setShowFileAttention, showSessions, setShowSessions, showConversation,
    showContext, setShowContext, showSystem, setShowSystem,
    toggleExclusivePanel, openConversation, closeConversation, closeTopPanel, registerPanel,
  } = panels
  // "N names hidden" (#594): opens the Sessions and agents list, or, when it is already open, moves the focus to the
  // list's Tab stop (the row that takes Tab), not to the resize handle drawn before the header
  const sessionsPanelRef = panels.panelRefs.sessions
  const showAgentList = useCallback(() => {
    const panel = sessionsPanelRef.current
    if (showSessions) (panel?.querySelector<HTMLElement>('[data-row-main][tabindex="0"]') ?? panel?.querySelector<HTMLElement>(FOCUSABLE))?.focus()
    else setShowSessions(true)
  }, [showSessions, setShowSessions, sessionsPanelRef])

  // Relay origin for on-demand reads ('' = same origin, standalone app)
  const contextOrigin = bridge.relayPort ? `http://127.0.0.1:${bridge.relayPort}` : ''
  const fetchContext = useCallback(
    (id: string) => fetchProjectContext(contextOrigin, id),
    [contextOrigin],
  )

  const [zoomToFitTrigger, setZoomToFitTrigger] = useState(0)

  const { selectedLinkId, setSelectedLinkId, handleLinkClick, handleCanvasAgentClick, labelledSimulationRef } =
    useCanvasSelection(selection, { agents, links, frameRef }, bridge.sessions)

  const { isMuted, seekingRef, handleToggleMute } = useAudioEffects(agents, toolCalls, isReviewing)

  // ?scenario=guided only means the guided demo on the demo data: a relay or VS Code takes over from it
  const isGuidedDemo = IS_GUIDED_DEMO && bridge.useMockData
  const onReviewEnded = useCallback(() => {
    setIsReviewing(false)
    pushToast({ message: 'Review ended: session changed', durationMs: 4000 })
  }, [pushToast])
  const sessionCacheRef = useSessionViewSwap({ bridge, restart, saveSnapshot, restoreSnapshot, isReviewingRef, onReviewEnded })

  const { events: timelineEvents, lost: lostMarkers } = useTimelineEvents(conversations, droppedMessages)

  const zoomToFit = useCallback(() => setZoomToFitTrigger(n => n + 1), [])
  const {
    handlePlayPause, handleEnterReview, setSpeedInReview, handleResumeLive, handleClearHistory, handleReloadSessionEvents, handleSeek,
  } = useReviewControls({
    sim: { isPlaying, maxTimeReached, play, pause, restart, setSpeed, seekToTime, saveSnapshot, restoreSnapshot },
    bridge, isReviewing, setIsReviewing, pushToast, seekingRef, zoomToFit, autoPlay: !isGuidedDemo, eventCount: timelineEvents.length,
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

  const modes = useChromeModes(agents, closeTopPanel)
  const {
    immersive, toggleFullscreen, exitFullscreenRef, fullscreenNote,
    presentation, presentationOn, presentationMasked, presentationSubtitle, presentationNote,
  } = modes

  useVisualizerShortcuts({
    panels, modes, clearSelection: selection.clearAllSelections, togglePlayPause: handlePlayPause, zoomToFit, toggleMute: handleToggleMute,
    setSpeed: setSpeedInReview, openShortcuts, openPalette, undoLast, openSettings, singleKeyEnabled: singleKeyShortcuts,
  })

  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const { usage, attention, notifyRules, setNotifyRules, notifyState, toggleNotify, health, jumpToAttention, nextAttentionInView } = useAttentionSummary({
    sim: { agents, unattributed, foreignAttention, conversations, droppedMessages, catchUp },
    agentsRef, bridge, selectAgent: selection.handleAgentClick, selectedAgentId: selection.selectedAgentId,
  })

  // Events the relay could not replay, per session (#366): qualifies the numbers the canvas draws and the totals read aloud
  const replayLostBySession = useMemo(() => new Map(Object.entries(bridge.eventLoss?.evicted ?? {})), [bridge.eventLoss])
  const unattributedEstimated = useMemo(() => Array.from(unattributed.values()).some(u => u.estimated === true), [unattributed])
  const shownUsage = useMemo(() => {
    // The sessions of the agents and of the usage that belongs to no agent: both are in the totals
    const lost = replayLostForAgents(replayLostBySession, [...agents.values(), ...unattributed.values()])
    return { tokens: usageUnderLoss(usage.tokens, lost), cost: usageUnderLoss(usage.cost, lost) }
  }, [usage, replayLostBySession, agents, unattributed])

  const inspector = useInspector(selection, { agents, conversations, droppedMessages, edges, fileAttention })

  const menuActions = {
    showStats, showGrid: showHexGrid,
    toggleStats: () => setShowStats(prev => !prev),
    zoomToFit,
    toggleGrid: () => setShowHexGrid(prev => !prev),
    clearHistory: handleClearHistory,
    reloadSessionEvents: !bridge.useMockData && bridge.selectedSessionId ? handleReloadSessionEvents : null,
  }

  const sessionActions = useSessionActions({ bridge, uiPrefs, pushToast, sessionCacheRef })

  const openFile = useCallback((filePath: string, line?: number) => {
    bridge.bridgeOpenFile(filePath, line)
  }, [bridge])

  const {
    activeAgentCount, doneAgentCount, staleAgentCount, idleAgentCount, errorAgentCount, allSessionCount, connection, selectedSessionLabel,
    hiddenKeepIds, listAgents, blankByHidingCount, labelledAgents, sessionMeta, sessionLinks, permissionSessionLabel,
  } = useChromeData(agents, agentsRef, bridge, selection.selectedAgentId, hideInactiveShown)

  // Team props are spread so each panel picks the ones it declares
  const canvasTeamProps = {
    links, teams, onLinkClick: handleLinkClick, selectedLinkId, scopeKey: bridge.selectedSessionId ?? '',
    sessions: sessionMeta, onClusterSelect: sessionActions.handleClusterSelect, sessionLinks,
  }
  const feedTeamProps = { links, droppedMessages, teams }

  // Counters of the selection: one session, or every session added up for a union view (All, team pseudo selection)
  const truncationKey = truncationDismissKey(bridge.selectedSessionId)
  // A union view adds up only the sessions it counts, the scope of the replay loss (#366)
  const truncationStats = useMemo(
    () => viewNormalizationStats(normalizationStats, bridge.selectedSessionId, bridge.viewSessionIds),
    [normalizationStats, bridge.selectedSessionId, bridge.viewSessionIds],
  )
  // What the normalizer discarded plus what the relay could not replay (#366): see lib/event-loss
  // The rule depends on where the replay figure comes from (#605 review, round 4): the VS Code extension lowers its figure
  // while the page is open, so with it only a total above the dismissed one brings the notice back; with the relay a lower
  // total is a new loss too (#569)
  const truncation = truncationBannerState(truncationStats, bridge.replayLost, truncationDismissed.get(truncationKey), bridge.eventLossSource)
  const truncationShown = truncation.show && !immersive
  // Reopened from the indicator for this view only: another view's banner never opens its details or takes the focus
  const truncationReopenedHere = truncationReopened !== null && truncationReopened.key === truncationKey
  useEffect(() => {
    if (truncationReopened !== null && truncationReopened.key !== truncationKey) setTruncationReopened(null)
  }, [truncationKey, truncationReopened])
  const dismissTruncationBanner = () => {
    // Dismissing All also covers each session it counted, at that session's own total (#567)
    const isAll = truncationKey === truncationDismissKey(null)
    const covered = isAll ? allViewSessionTotals(normalizationStats, bridge.eventLoss, bridge.allViewSessionIds) : undefined
    // What each session's own view counts now: an older, higher dismissal above it is stale (#569 review)
    const own = isAll ? allViewSessionTotals(normalizationStats, bridge.eventLoss, null) : undefined
    const next = dismissTruncation(truncationDismissed, truncationKey, truncation.total, covered, own)
    writeTruncationDismissals(tabStorage(), next)
    setTruncationDismissed(next)
    setTruncationReopened(null)
  }
  const reopenTruncationBanner = () => {
    const next = new Map(truncationDismissed)
    next.delete(truncationKey)
    writeTruncationDismissals(tabStorage(), next)
    setTruncationDismissed(next)
    setTruncationReopened(prev => ({ key: truncationKey, n: (prev?.key === truncationKey ? prev.n : 0) + 1, focus: true }))
  }
  // The banner took the focus the user asked for: a later mount of it (leaving full screen, back after its total fell to 0)
  // keeps Details expanded but never moves the focus again (#569 review)
  const truncationFocusTaken = useCallback(() => setTruncationReopened(prev => (prev && prev.focus ? { ...prev, focus: false } : prev)), [])

  const isEmpty = agents.size === 0 && !bridge.useMockData

  const scopeProps = useScopeControls(bridge, uiPrefs)

  const { tour, steps: tourSteps, tourBridge, tourStale, getTourAgents, exitTour } = useTourController({
    seek: handleSeek, play, isGuidedDemo, frameRef, setTourShowsInactive,
  })
  // The quota only comes from the relay stream: no gauge, and no setting that would do nothing, in VS Code, the demo or the tour
  const quotaSourceActive = quotaStreamActive({ relayOrigin: bridge.relayOrigin, isVSCode: bridge.isVSCode, useMockData: bridge.useMockData, tourActive: tour.active })
  const quotaSettingActive = quotaStreamActive({ relayOrigin: bridge.relayOrigin, isVSCode: bridge.isVSCode, useMockData: bridge.useMockData })
  // Offered once, on the first launch, as soon as the legend can start a tour (#377)
  // A pending permission card comes first: the offer waits (not spent) until none is shown
  const [permissionShown, setPermissionShown] = useState(false)
  const tourOffer = useTourOffer({
    canStart: Boolean(tourBridge.startTour), tourActive: tour.active, guidedDemo: isGuidedDemo, immersive, presentation: presentationOn, permissionShown,
  })

  // One source for the dialog and the palette: a command never opens a tab the dialog leaves out
  const settingsAnnouncements = { level: prefs.announceLevel, onLevelChange: updateAnnounceLevel }
  const settingsNotifications = { state: notifyState, onToggle: toggleNotify, rules: notifyRules, onRulesChange: setNotifyRules }
  const settingsTabsShown = visibleSettingsTabs({ notifications: Boolean(settingsNotifications), announcements: Boolean(settingsAnnouncements) })
  const paletteItems = usePaletteItems({
    open: showPalette, singleKeyEnabled: singleKeyShortcuts, bridge, listAgents, panels, selectAgent: selection.handleAgentClick,
    actions: {
      togglePlayPause: handlePlayPause, zoomToFit, toggleFullscreen, toggleMute: handleToggleMute, openShortcuts, openSettings, openSettingsTab, settingsTabs: settingsTabsShown,
      togglePresentation: presentation.toggle, clearHistory: handleClearHistory,
    },
    exportSession: { can: sessionActions.canExportSession, run: sessionActions.handleExportSession },
    tour: { start: tourBridge.startTour, label: tourBridge.startTourLabel },
    attention: { waiting: attention.waiting, errors: attention.errors, jump: jumpToAttention, nextInView: nextAttentionInView },
    notify: { state: notifyState, toggle: toggleNotify },
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

      <TruncationAnnouncer shown={truncationShown} />

      <HiddenFinishedAnnouncer agents={agents} hideInactive={hideInactiveShown} keepIds={hiddenKeepIds} />

      {/* Burst of received events being caught up over several frames (#210) */}
      <HistoryLoadingIndicator progress={catchUp} />

      {/* Top bar: sessions button + info/controls (banner landmark; offset var --topbar-h is published for panels) */}
      <div style={{ display: immersive ? 'none' : 'contents' }}>
      <TopBar
        onToggleFullscreen={toggleFullscreen} sessions={bridge.sessions} teams={bridge.teams} allSessionCount={allSessionCount}
        lossMarked={truncation.total > 0 && !truncation.show}
        showMode={showMode} onChangeShowMode={updateShowMode} finishedSessionCount={bridge.finishedSessionCount}
        selectedSessionId={bridge.selectedSessionId} sessionsWithActivity={bridge.sessionsWithActivity}
        showSessions={showSessions} onToggleSessions={() => setShowSessions(prev => !prev)}
        isVSCode={bridge.isVSCode} connectionStatus={bridge.connectionStatus} isDemo={bridge.useMockData}
        scope={bridge.relayOrigin !== null ? scopeProps : undefined}
        connectionDetail={bridge.connectionDetail} onRetryConnection={bridge.relayOrigin !== null ? bridge.retryRelay : undefined} onExitDemo={bridge.exitDemo}
        activeAgentCount={activeAgentCount} staleAgentCount={staleAgentCount} idleAgentCount={idleAgentCount} errorAgentCount={errorAgentCount} doneAgentCount={doneAgentCount}
        totalTokens={usage.summary.sessionTokens} totalCost={usage.summary.sessionCost} tokenUsage={shownUsage.tokens} costUsage={shownUsage.cost}
        unattributedTokens={usage.summary.unattributedTokens} unattributedCost={usage.summary.unattributedCost} unattributedEstimated={unattributedEstimated}
        showFileAttention={showFileAttention} showConversation={showConversation} showContext={showContext} showSystem={showSystem}
        showCostOverlay={showCostOverlay} showTimeline={showTimeline} showStats={showStats} isMuted={isMuted}
        onToggleStats={() => setShowStats(prev => !prev)}
        onTogglePanel={panel => (panel === 'system' ? setShowSystem(prev => !prev) : toggleExclusivePanel(panel))}
        onToggleTimeline={() => setShowTimeline(prev => !prev)}
        onToggleMute={handleToggleMute} onOpenShortcuts={openShortcuts} onOpenSettings={openSettings} onOpenPalette={openPalette}
        attention={attention} onJumpToAttention={jumpToAttention} notifyState={notifyState} onToggleNotify={toggleNotify}
        quota={bridge.quota} selectedRuntime={selectedRuntime} showQuota={showQuota && quotaSourceActive}
      />
      </div>

      {/* One column under the top bar (#453): the open panels a sheet hides (#410), then the truncation banner. After the
          top bar in the Tab order; the docks treat the banner as an obstacle and a sheet keeps the column's measured height
          free. The banner is left out in full screen like the rest of the chrome. */}
      <UnderTopbarStack
        contextOpen={showContext}
        banner={truncationShown ? (
          <TruncationBanner
            key={`${truncationKey}#${truncationReopenedHere ? truncationReopened?.n ?? 0 : 0}`}
            stats={truncationStats}
            replayLost={bridge.replayLost}
            returnFocusId={PANEL_BUTTON_IDS.sessions}
            initialOpen={truncationReopenedHere}
            takeFocus={truncationReopenedHere && truncationReopened?.focus === true}
            onFocusTaken={truncationFocusTaken}
            onDismiss={dismissTruncationBanner}
          />
        ) : null}
      />

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
          style={{ zIndex: Z.notice, background: 'var(--lens-scrim)', color: SCENE.textPrimary, border: `1px solid ${SCENE.textPrimary}` }}
        >
          <FullscreenIcon exit />
        </button>
      )}

      <main id="visualizer-main" aria-label="Agent visualizer" tabIndex={-1} className="absolute inset-0 outline-none">
      <h1 className="sr-only">Agent Lens</h1>

      {isEmpty && <EmptyState bridge={bridge} />}

      {blankByHidingCount > 0 && !isEmpty && (
        <HiddenFinishedNotice count={blankByHidingCount} onShow={() => updateShowMode('all')} focusTargetId="visualizer-main" />
      )}

      {/* In full screen too: the canvas still draws the Cost panel there, and the region is sr-only (no visual footprint) */}
      {showCostOverlay && <CostTotalsText tokens={shownUsage.tokens} cost={shownUsage.cost} agents={agents.values()} unattributed={unattributed.values()} />}

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
        onLayoutKeepIds={setLayoutKeepIds}
        announceLevel={prefs.announceLevel}
        health={health.byAgent}
        replayLost={replayLostBySession}
        presentation={{ follow: presentationOn && presentation.options.follow, mask: presentationMasked }}
        onShowAgentList={showAgentList}
        agentListKey={singleKeyShortcuts ? "L" : null}
        openViewRequest={viewControlsRequest}
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
        onEscapeFromCard={escapeFromDetailCard} menuActions={menuActions}
      />

      {/* Floating control strip */}
      <div style={{ display: immersive ? 'none' : 'contents' }}>
      <ControlBar
        isPlaying={isPlaying} speed={speed} currentTime={currentTime}
        totalDuration={bridge.useMockData
          ? (isReviewing ? Math.max(maxTimeReached, currentTime) : MOCK_DURATION)
          : Math.max(maxTimeReached, currentTime)
        }
        onPlayPause={handlePlayPause} onRestart={handleClearHistory} onSpeedChange={setSpeedInReview}
        isDemo={bridge.useMockData} connectionStatus={bridge.connectionStatus} onSeek={handleSeek}
        timelineEvents={timelineEvents} eventCount={timelineEvents.length} isReviewing={isReviewing}
        onEnterReview={handleEnterReview} onResumeLive={handleResumeLive} droppedEvents={droppedEvents} lostMarkers={lostMarkers}
      />
      </div>

      {/* Drawn just above the canvas controls: next to them in the Tab order too (#377) */}
      <TourOffer
        open={tourOffer.open} label={tourBridge.startTourLabel}
        onStart={() => tourBridge.startTour?.()} onDismiss={tourOffer.dismiss}
      />

      <PanelDock
        panels={panels} sim={{ fileAttention, waste, agents, timelineEntries, currentTime }} bridge={bridge} selection={selection}
        attention={attention} health={health} sessionActions={sessionActions} uiPrefs={uiPrefs} allSessionCount={allSessionCount}
        agentCounts={{ active: activeAgentCount, done: doneAgentCount, stale: staleAgentCount, idle: idleAgentCount, error: errorAgentCount }}
        lossIndicator={<TruncationIndicator stats={truncationStats} replayLost={bridge.replayLost} onShow={reopenTruncationBanner} />}
        replayLostBySession={replayLostBySession}
        listAgents={listAgents} agentLabel={agentLabel} openFile={openFile} fetchContext={fetchContext} contextOrigin={contextOrigin}
        tourShowsInactive={tourShowsInactive}
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
      <PermissionRequests sessionLabel={permissionSessionLabel} onShownChange={setPermissionShown} />
      </main>

      <VisualizerDialogs
        settings={{
          open: showSettings, onClose: closeSettings, tab: settingsTab, onTabChange: setSettingsTab, hexGrid: showHexGrid, onHexGridChange: setShowHexGrid,
          muted: isMuted, onToggleMute: handleToggleMute, showMode, onShowModeChange: updateShowMode, singleKeyEnabled: singleKeyShortcuts,
          onSingleKeyEnabledChange: updateSingleKeyShortcuts, onOpenShortcuts: openShortcuts, onResetPrefs: uiPrefs.resetPrefs, onOpenViewControls: openViewControls,
          presentation: { active: presentationOn, onActiveChange: v => presentation.setActive(v), options: presentation.options, onOptionChange: presentation.setOption },
          announcements: settingsAnnouncements,
          quota: quotaSettingActive ? { show: showQuota, onShowChange: updateShowQuota } : undefined,
          notifications: settingsNotifications,
        }}
        palette={{ open: showPalette, onClose: closePalette, items: paletteItems }}
        shortcuts={{ open: showShortcuts, onClose: closeShortcuts, singleKeyEnabled: singleKeyShortcuts, onSingleKeyEnabledChange: updateSingleKeyShortcuts }}
      />
    </div>
    </OpenFileProvider>
    </TourBridgeContext.Provider>
    </PanelRegistryContext.Provider>
  )
}
