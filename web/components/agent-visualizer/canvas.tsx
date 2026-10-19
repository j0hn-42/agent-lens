'use client'

import { useRef, useState, useCallback, useEffect } from 'react'
import { COLORS } from '@/lib/colors'
import type { HitTarget, Cluster } from './canvas/index'
import { graphKeyboardHelp } from '@/lib/shortcuts'
import { buildNodeOrder, sameNode, type NavNode } from './canvas/keyboard-nav'
import { describeTooltip } from './canvas/tooltip'
import type { CanvasProps } from './canvas/canvas-props'
import { GraphA11yList, type AuxFocusItem } from './graph-a11y-list'
import { CanvasControls } from './canvas-controls'
import { useCanvasCamera } from '@/hooks/use-canvas-camera'
import { useCanvasInteraction } from '@/hooks/use-canvas-interaction'
import { useCanvasPreferences } from '@/hooks/use-canvas-preferences'
import { useCanvasViewport } from '@/hooks/use-canvas-viewport'
import { useCanvasInsets } from '@/hooks/use-canvas-insets'
import { useCanvasDrawProps } from '@/hooks/use-canvas-draw-props'
import { useCanvasA11yMirror } from '@/hooks/use-canvas-a11y-mirror'
import { useCanvasStateEffects } from '@/hooks/use-canvas-state-effects'
import type { AnnounceLevel } from '@/lib/ui-preferences'
import { useCanvasDrawLoop } from '@/hooks/use-canvas-draw-loop'
import { useHiddenNamesDisplay } from '@/hooks/use-hidden-names-display'
import { useTourBridge } from './guided-tour-context'

type PresentationFlags = { follow: boolean; mask: boolean }
const NO_PRESENTATION: PresentationFlags = { follow: false, mask: false }

export function AgentCanvas(props: CanvasProps) {
  const {
    simulationRef, selectedAgentId, hoveredAgentId, zoomToFitTrigger,
    onAgentClick, onToolCallClick, onDiscoveryClick,
    links: linksProp, teams, onLinkClick, selectedLinkId, sessions, sessionLinks, onClusterSelect, scopeKey, presentation, onShowAgentList, agentListKey, openViewRequest,
  } = props
  const presentationRef = useRef<PresentationFlags>(NO_PRESENTATION)
  presentationRef.current = presentation ?? NO_PRESENTATION
  const announceLevelRef = useRef<AnnounceLevel>('all')
  announceLevelRef.current = props.announceLevel ?? 'all'
  const mainCanvasRef = useRef<HTMLCanvasElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const simTimeRef = useRef(0)

  const { containerRef, dimensions, dprRef } = useCanvasViewport()
  const prefs = useCanvasPreferences()

  // ─── Keyboard focus state ───────────────────────────────────────────────
  const [focusedNode, setFocusedNode] = useState<NavNode | null>(null)
  const focusedNodeRef = useRef<NavNode | null>(null)
  focusedNodeRef.current = focusedNode
  const [hasFocus, setHasFocus] = useState(false)
  const hasFocusRef = useRef(false)
  hasFocusRef.current = hasFocus
  // Outline button without a canvas node holding the focus (cluster, link, branch): no agent ring, a visible label instead (#195)
  const [auxFocus, setAuxFocus] = useState<AuxFocusItem | null>(null)
  const handleFocusAux = useCallback((item: AuxFocusItem | null) => {
    setAuxFocus(item)
    if (item) setFocusedNode(null)
  }, [])
  const hoverTargetRef = useRef<HitTarget | null>(null)
  const tooltipTargetRef = useRef<NavNode | null>(null)

  const handleFocusedNodeChange = useCallback((node: NavNode | null) => {
    setFocusedNode(prev => (sameNode(prev, node) ? prev : node))
  }, [])
  const handleHoverTargetChange = useCallback((target: HitTarget | null) => {
    hoverTargetRef.current = target
  }, [])

  // ─── Props read by the draw loop and the snapshot timer without re-subscribing ───
  const onLinkClickRef = useRef(onLinkClick)
  onLinkClickRef.current = onLinkClick
  const linksPropRef = useRef(linksProp)
  linksPropRef.current = linksProp
  const teamsRef = useRef(teams)
  teamsRef.current = teams
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const sessionLinksRef = useRef(sessionLinks)
  sessionLinksRef.current = sessionLinks
  const onClusterSelectRef = useRef(onClusterSelect)
  onClusterSelectRef.current = onClusterSelect
  /** Clusters of the last drawn frame (read by the cluster click handler and the camera fit) */
  const clustersRef = useRef<Cluster[]>([])
  /** Agent names the last planned frame does not draw (written by the draw loop, #594) */
  const hiddenAgentNamesRef = useRef(0)
  const [selectedClusterKey, setSelectedClusterKey] = useState<string | null>(null)
  const selectedClusterKeyRef = useRef<string | null>(null)
  selectedClusterKeyRef.current = selectedClusterKey

  // ─── Scene (visible agents, collapsed branches) shared by the loop and the handlers ───
  const {
    drawPropsRef, hideInactiveRef, collapseMemoryRef, collapseViewRef, handleToggleBranch, handleClusterClickRef,
  } = useCanvasDrawProps(props, { hasFocus, focusedNode, dimensions })

  const { getInsets, getSafeArea, getCovers, refreshInsetsIfStale } = useCanvasInsets(mainCanvasRef)

  // ─── Camera ─────────────────────────────────────────────────────────────
  const {
    transformRef, userHasNavigatedRef, panVelocityRef,
    screenToCanvas, doZoomToFit, updateCamera, isCameraBusy, zoomBy, panBy, canvasToScreen, ensureVisible, zoomToCircle,
  } = useCanvasCamera({
    mainCanvasRef, drawPropsRef, simTimeRef, dimensions,
    agentCount: simulationRef.current.agents.size, zoomToFitTrigger, selectedAgentId,
    clustersRef, getInsets, scopeKey, presentationRef, reducedMotionRef: prefs.reducedMotionRef,
  })
  // "N names hidden" (#594): shown, changed or removed only on a stable count with the camera at rest
  const hiddenNames = useHiddenNamesDisplay(hiddenAgentNamesRef, isCameraBusy)
  const { canvasToScreenRef: tourCanvasToScreenRef, reportPresence } = useTourBridge()
  tourCanvasToScreenRef.current = canvasToScreen

  // ─── Cluster selection (halo label click or outline button): zoom to the cluster, tell the app ───
  const selectCluster = useCallback((key: string) => {
    const c = clustersRef.current.find(x => x.key === key)
    if (!c) return
    setSelectedClusterKey(key)
    zoomToCircle(c.cx, c.cy, c.r)
    onClusterSelectRef.current?.({ key: c.key, kind: c.kind, sessionIds: c.sessionIds, teamName: c.teamName })
  }, [zoomToCircle])
  handleClusterClickRef.current = selectCluster

  // ─── Interaction ────────────────────────────────────────────────────────
  const {
    isDragging, overInteractive, handlers, keyHandlers, updateDragLerp, focusNode,
  } = useCanvasInteraction({
    drawPropsRef, transformRef, userHasNavigatedRef, panVelocityRef,
    simTimeRef, screenToCanvas, doZoomToFit, mainCanvasRef,
    zoomBy, panBy, canvasToScreen, ensureVisible,
    focusedNodeRef, onFocusedNodeChange: handleFocusedNodeChange,
    onHoverTargetChange: handleHoverTargetChange,
  })

  // Keep drawPropsRef in sync with interaction state
  drawPropsRef.current.isDragging = isDragging

  // ─── Accessible mirror, state effects, draw loop ────────────────────────
  const { a11yModel, communications, linkMessages, legendPresence, legendShown, bubbleLayerRef, heldBubbleKeysRef } = useCanvasA11yMirror({
    simulationRef, mainCanvasRef, drawPropsRef, hideInactiveRef, hasFocusRef, focusedNodeRef,
    collapseMemoryRef, collapseViewRef, linksPropRef, teamsRef, sessionsRef, sessionLinksRef, onLinkClickRef,
  })
  useEffect(() => { reportPresence?.(legendPresence) }, [legendPresence, reportPresence])
  const { effectsRef, announcements, detectStateChanges } = useCanvasStateEffects({
    simulationRef, drawPropsRef, reducedMotionRef: prefs.reducedMotionRef, linksPropRef, announceLevelRef,
  })
  useCanvasDrawLoop({
    simulationRef, mainCanvasRef, tooltipRef, bubbleLayerRef, drawPropsRef, transformRef, simTimeRef, dimensions, dprRef,
    hideInactiveRef, collapseMemoryRef, collapseViewRef, focusedNodeRef, hasFocusRef, hoverTargetRef, tooltipTargetRef,
    heldBubbleKeysRef, selectedClusterKeyRef, clustersRef, hiddenAgentNamesRef,
    linksPropRef, teamsRef, sessionsRef, sessionLinksRef,
    presentationRef, reducedMotionRef: prefs.reducedMotionRef, animationsPausedRef: prefs.animationsPausedRef, globalReducedRef: prefs.globalReducedRef, calmLayersRef: prefs.calmLayersRef, neverHideRef: prefs.neverHideRef,
    updateCamera, isCameraBusy, updateDragLerp, refreshInsetsIfStale, getSafeArea, getCovers, effectsRef, detectStateChanges,
  })

  // ─── Tooltip target (hover or keyboard focus) ──────────────────────────
  const focusedForTooltip = hasFocus ? focusedNode : null
  const rawTooltipTarget: NavNode | null = hoveredAgentId
    ? { type: 'agent', id: hoveredAgentId }
    : focusedForTooltip
  // Escape dismisses the tooltip of the current target (WCAG 1.4.13) without moving pointer or focus;
  // another target brings it back
  const rawTooltipTargetRef = useRef<NavNode | null>(null)
  rawTooltipTargetRef.current = rawTooltipTarget
  const [dismissedTip, setDismissedTip] = useState<NavNode | null>(null)
  const rawTipKey = rawTooltipTarget ? `${rawTooltipTarget.type}:${rawTooltipTarget.id}` : null
  useEffect(() => {
    setDismissedTip(d => (d && `${d.type}:${d.id}` === rawTipKey ? d : null))
  }, [rawTipKey])
  useEffect(() => {
    if (!rawTipKey) return
    // Document level: a hovered tooltip shows while the focus is elsewhere. Not stopped: the global
    // Escape order (panels, selection) still runs
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDismissedTip(rawTooltipTargetRef.current) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [rawTipKey])
  const tooltipTarget: NavNode | null = rawTooltipTarget && dismissedTip && sameNode(dismissedTip, rawTooltipTarget)
    ? null
    : rawTooltipTarget
  tooltipTargetRef.current = tooltipTarget
  const tooltipContent = tooltipTarget ? describeTooltip(tooltipTarget, simulationRef.current) : null

  // ─── Keyboard focus entry ──────────────────────────────────────────────
  // Runs from the root's focus observer (the graph surface itself carries only its key handlers)
  const graphSurfaceRef = useRef<HTMLDivElement>(null)
  const handleSurfaceFocus = useCallback((e: React.FocusEvent) => {
    const surface = graphSurfaceRef.current
    if (!surface || e.target !== surface || focusedNodeRef.current) return
    // Only keyboard focus gets the automatic ring; a mouse click must not (matches :focus-visible)
    try { if (!surface.matches(':focus-visible')) return } catch { /* older engines: fall through */ }
    // Show the ring immediately when keyboard focus lands on the graph
    const p = drawPropsRef.current
    const order = buildNodeOrder(p.agents, p.toolCalls, p.discoveries)
    const selected = p.selectedAgentId ? order.find(n => n.type === 'agent' && n.id === p.selectedAgentId) : undefined
    const first = selected ?? order[0] ?? null
    if (first) focusNode(first)
  }, [focusNode, drawPropsRef])

  const rootCursor = isDragging ? 'grabbing' : overInteractive ? 'pointer' : 'grab'

  return (
    // Root: a presentational focus observer (has focus within: focus tooltip, keyboard focus entry); it is
    // not an interaction target itself
    <div
      ref={containerRef}
      role="presentation"
      data-agent-canvas-root=""
      className="relative w-full h-full overflow-hidden"
      style={{ cursor: rootCursor }}
      onFocus={(e) => { setHasFocus(true); handleSurfaceFocus(e) }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false)
      }}
    >
      {/* Graph surface: one image for assistive tech (its content is in the outline below),
          focusable so the keyboard map works (arrows, Enter, +/-/0, Shift+arrows, context menu key). */}
      <div
        ref={graphSurfaceRef}
        role="img"
        aria-label={a11yModel.summary}
        aria-describedby="graph-keyboard-help"
        tabIndex={0}
        onPointerDownCapture={(e) => { if (e.pointerType === 'mouse') setFocusedNode(null) }}
        {...keyHandlers}
        className="absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--lens-focus)]"
      >
        <canvas
          ref={mainCanvasRef}
          style={{ width: dimensions.width, height: dimensions.height, touchAction: 'none' }}
          {...handlers}
          className="w-full h-full"
        />
      </div>
      {/* Focusable buttons of the bubbles anchored on the edges (positioned each frame by the draw loop) */}
      <div
        ref={bubbleLayerRef}
        data-edge-bubble-layer=""
        className="absolute inset-0 overflow-hidden pointer-events-none [&_button]:min-h-6 [&_button]:min-w-6 [&_button]:focus-visible:outline-2 [&_button]:focus-visible:outline-[color:var(--lens-focus)] [&_button]:focus-visible:shadow-none [&_button]:focus-visible:outline-offset-2"
      />
      {auxFocus && (
        <div
          aria-hidden="true"
          data-aux-focus={auxFocus.kind}
          className="pointer-events-none absolute left-1/2 top-3 z-10 max-w-[min(32rem,calc(100vw-24px))] -translate-x-1/2 truncate rounded-md px-3 py-1 font-mono text-xs"
          style={{ background: COLORS.panelBg, color: COLORS.textPrimary, border: `2px solid ${COLORS.textPrimary}` }}
        >
          {auxFocus.label}
        </div>
      )}
      <p id="graph-keyboard-help" className="sr-only">{graphKeyboardHelp()}</p>

      <GraphA11yList
        model={a11yModel}
        onLinkClick={onLinkClick}
        linkMessages={linkMessages}
        selectedLinkId={selectedLinkId}
        onClusterClick={selectCluster}
        selectedClusterKey={selectedClusterKey}
        communications={communications}
        announcements={announcements}
        focusedNode={focusedNode}
        onAgentClick={onAgentClick}
        onToolCallClick={onToolCallClick}
        onDiscoveryClick={onDiscoveryClick}
        onFocusNode={focusNode}
        onFocusAux={handleFocusAux}
        onToggleBranch={handleToggleBranch}
      />

      {/* Hover / focus tooltip (mirrors information available in the outline, so hidden from AT) */}
      <div
        ref={tooltipRef}
        aria-hidden="true"
        data-sensitive=""
        className="pointer-events-none absolute left-0 top-0 z-10 max-w-[min(20rem,calc(100vw-24px))] rounded-md px-2 py-1 font-mono text-xs"
        style={{
          visibility: 'hidden',
          background: COLORS.panelBg,
          border: `1px solid ${COLORS.glassBorder}`,
          color: COLORS.textPrimary,
        }}
      >
        {tooltipContent && (
          <>
            <div className="break-words font-semibold">{tooltipContent.title}</div>
            {tooltipContent.lines.map((line, i) => (
              <div key={i} className="break-words" style={{ color: COLORS.textMuted }}>{line}</div>
            ))}
          </>
        )}
      </div>

      <CanvasControls
        teams={a11yModel.teams}
        present={legendShown}
        zoomBy={zoomBy}
        doZoomToFit={doZoomToFit}
        animationsPaused={prefs.animationsPaused}
        pausedBySystem={prefs.pausedBySystem}
        locale={prefs.locale}
        calmLayers={prefs.calmLayers}
        onToggleCalmLayer={prefs.toggleCalmLayer}
        neverHide={prefs.neverHide}
        toolExpiryS={prefs.toolExpiryS}
        onToggleAnimationsPaused={prefs.toggleAnimationsPaused}
        onToggleNeverHide={prefs.toggleNeverHide}
        onChangeToolExpiry={prefs.changeToolExpiry}
        hiddenNames={hiddenNames}
        onShowAgentList={onShowAgentList}
        agentListKey={agentListKey}
        openViewRequest={openViewRequest}
      />
    </div>
  )
}
