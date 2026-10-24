import { useRef, useEffect, type MutableRefObject, type RefObject } from 'react'
import type { Particle, Edge, DepthParticle, TeamSummary } from '@/lib/agent-types'
import type { SessionLink } from '@/lib/session-links'
import type { SimulationState, AgentLink } from '@/hooks/simulation/types'
import {
  ANIM_SPEED, PERF_OVERLAY_ENABLED, PERF_BASELINE, EDGE_BUBBLE, expiryHold,
} from '@/lib/canvas-constants'
import { BloomRenderer } from '@/components/agent-visualizer/bloom-renderer'
import { createDepthParticles, updateDepthParticles, drawBackground } from '@/components/agent-visualizer/background-layer'
import {
  type VisualEffect,
  drawEffects, drawAgents, drawMessageBubblesWorld,
  drawEdges, getActiveEdgeIds,
  delegationPathEdges, drawDelegationPath, createPathAnimation,
  drawParticles, buildEdgeMap, drawToolCalls,
  drawDiscoveries, drawDiscoveryConnections,
  drawCostLabels, drawCostSummaryPanel,
  drawFocusRing, focusShapeFor, toolCardSize, stateColor, lodForZoom, discoveryCardScale, frameLevel,
  drawLinks, drawEdgeBubbles, drawFileConflicts, fileConflictSegments, drawWorkspaceZones, computeWorkspaceZones, workspaceHeaderRect, workspaceHeaderHits, drawClusterHalos, drawClusterLabels, drawSessionLinks, drawPhaseLabels, phaseLabels, sessionLinkSegments, resolveLinks, hasSeveralSessions,
  computeClusters, planOverlays, setOverlayHits, clearOverlayHits, EMPTY_PLAN,
  type Cluster, type SessionMeta, type OverlayPlanResult, type DrawOpts, type HitTarget,
} from '@/components/agent-visualizer/canvas/index'
import { searchFlowSegments, searchFlowMoves, drawSearchFlow } from '@/components/agent-visualizer/canvas/search-flow'
import { measureTextCached, getToolCardSize } from '@/components/agent-visualizer/canvas/render-cache'
import type { Transform } from '@/components/agent-visualizer/canvas/camera-fit'
import { sceneAgents, costScope } from '@/components/agent-visualizer/canvas/scene'
import type { CollapseMemory, CollapseView } from '@/components/agent-visualizer/canvas/branch-collapse'
import { drawBranchBadges } from '@/components/agent-visualizer/canvas/draw-branch-badges'
import type { NavNode } from '@/components/agent-visualizer/canvas/keyboard-nav'
import { selectEdgeBubbles, capEdgeBubbles, type KeyedEdgeBubble } from '@/components/agent-visualizer/canvas/edge-bubble-set'
import { syncBubbleButtons, type BubbleButtonSpec } from '@/components/agent-visualizer/canvas/edge-bubble-dom'
import { MOBILE_QUERY, TOUCH_TARGET_PX } from '@/lib/mobile-view'
import { createHaloEaser } from '@/components/agent-visualizer/canvas/halo-geometry'
import { planKey, toolCardRects } from '@/components/agent-visualizer/canvas/overlay-plan'
import { positionTooltip } from '@/components/agent-visualizer/canvas/tooltip'
import { createPerfStats, drawPerfOverlay, countPaintCalls } from '@/components/agent-visualizer/canvas/perf-overlay'
import { createDrawGate } from '@/components/agent-visualizer/canvas/draw-gate'
import { sceneStamp, sceneAnimating } from '@/components/agent-visualizer/canvas/scene-stamp'
import { repeatMarks, type RepeatMark } from '@/lib/repeat-marks'
import { viewRectFor } from '@/components/agent-visualizer/canvas/view-cull'
import { MOTION_LAYERS, layerIsCalm, type CalmLayers, type MotionLayer } from '@/lib/motion-layers'
import { sceneTheme } from '@/lib/scene-state-colors'
import type { CanvasDrawProps } from './use-canvas-draw-props'
import { deriveFileConflicts, type FileConflict } from '@/lib/file-conflicts'
import type { FileAttention } from '@/lib/agent-types'

interface DrawLoopDeps {
  simulationRef: RefObject<SimulationState>
  mainCanvasRef: RefObject<HTMLCanvasElement | null>
  tooltipRef: RefObject<HTMLDivElement | null>
  bubbleLayerRef: RefObject<HTMLDivElement | null>
  drawPropsRef: MutableRefObject<CanvasDrawProps>
  transformRef: MutableRefObject<Transform>
  simTimeRef: MutableRefObject<number>
  dimensions: { width: number; height: number }
  dprRef: MutableRefObject<number>
  // Shown scene / interaction state
  hideInactiveRef: MutableRefObject<boolean>
  collapseMemoryRef: MutableRefObject<CollapseMemory>
  collapseViewRef: MutableRefObject<CollapseView>
  focusedNodeRef: MutableRefObject<NavNode | null>
  hasFocusRef: MutableRefObject<boolean>
  hoverTargetRef: MutableRefObject<HitTarget | null>
  tooltipTargetRef: MutableRefObject<NavNode | null>
  heldBubbleKeysRef: MutableRefObject<ReadonlySet<string>>
  selectedClusterKeyRef: MutableRefObject<string | null>
  clustersRef: MutableRefObject<Cluster[]>
  /** Agent names the last planned frame does not draw (#594): read by the "N names hidden" button */
  hiddenAgentNamesRef?: MutableRefObject<number>
  // Latest props
  linksPropRef: MutableRefObject<Map<string, AgentLink> | undefined>
  teamsRef: MutableRefObject<Map<string, TeamSummary> | undefined>
  sessionsRef: MutableRefObject<ReadonlyMap<string, SessionMeta> | undefined>
  sessionLinksRef: MutableRefObject<ReadonlyArray<SessionLink> | undefined>
  /** Presentation mode (#245): masked text */
  presentationRef: MutableRefObject<{ follow: boolean; mask: boolean }>
  // Motion preferences
  reducedMotionRef: MutableRefObject<boolean>
  animationsPausedRef: MutableRefObject<boolean>
  /** Reduced motion from the OS or "Freeze motion" only (calms every layer) */
  globalReducedRef: MutableRefObject<boolean>
  /** Layers calmed one by one (#247) */
  calmLayersRef: MutableRefObject<CalmLayers>
  neverHideRef: MutableRefObject<boolean>
  // Camera, drag, insets, effects
  updateCamera: (isDragging: boolean, pauseAutoFit?: boolean) => void
  /** The camera is moving or about to: keep drawing every frame */
  isCameraBusy: () => boolean
  updateDragLerp: CanvasDragLerp
  refreshInsetsIfStale: (w: number, h: number, timestamp: number) => void
  getSafeArea: (w: number, h: number) => ReturnType<typeof import('@/components/agent-visualizer/canvas/camera-fit').safeRect>
  /** UI over the canvas that reserves no edge (the collapsed Conversation pill), in canvas px */
  getCovers: () => ReadonlyArray<import('@/components/agent-visualizer/canvas/camera-fit').Rect>
  effectsRef: MutableRefObject<VisualEffect[]>
  detectStateChanges: () => void
}
type CanvasDragLerp = (agents: CanvasDrawProps['agents'], onAgentDrag: CanvasDrawProps['onAgentDrag']) => void

/** Expiry hold: hovered / focused elements, paused playback or animations, and the "never hide" setting
 * stop bubbles, tool cards and discoveries from expiring. */
function syncExpiryHold(d: DrawLoopDeps, p: CanvasDrawProps): void {
  const focused = d.hasFocusRef.current ? d.focusedNodeRef.current : null
  const hover = d.hoverTargetRef.current
  expiryHold.neverHide = d.neverHideRef.current
  expiryHold.paused = d.animationsPausedRef.current || !d.simulationRef.current.isPlaying
  expiryHold.agentIds.clear()
  expiryHold.toolIds.clear()
  expiryHold.discoveryIds.clear()
  if (p.hoveredAgentId) expiryHold.agentIds.add(p.hoveredAgentId)
  if (hover?.type === 'agent' || hover?.type === 'bubble') expiryHold.agentIds.add(hover.id)
  if (hover?.type === 'tool') expiryHold.toolIds.add(hover.id)
  if (hover?.type === 'discovery') expiryHold.discoveryIds.add(hover.id)
  if (focused?.type === 'agent') expiryHold.agentIds.add(focused.id)
  if (focused?.type === 'tool') expiryHold.toolIds.add(focused.id)
  if (focused?.type === 'discovery') expiryHold.discoveryIds.add(focused.id)
  if (p.selectedToolCallId) expiryHold.toolIds.add(p.selectedToolCallId)
  if (p.selectedDiscoveryId) expiryHold.discoveryIds.add(p.selectedDiscoveryId)
}

/** Sync simulation data into the draw props — always fresh, independent of React renders. */
function syncSceneIntoDrawProps(d: DrawLoopDeps): void {
  const s = d.simulationRef.current
  const p = d.drawPropsRef.current
  const scene = sceneAgents(s.agents, d.hideInactiveRef.current, [p.selectedAgentId, p.hoveredAgentId],
    { agentId: p.selectedAgentId, toolCallId: p.selectedToolCallId ?? null, discoveryId: p.selectedDiscoveryId ?? null },
    d.hasFocusRef.current ? d.focusedNodeRef.current : null, d.collapseMemoryRef.current, s)
  d.collapseViewRef.current = scene.collapse
  // The hidden agents drawn all the same are laid out by the force layout too (#554)
  p.onLayoutKeepIds?.(scene.keptIds)
  p.agents = scene.agents
  p.collapse = scene.collapse
  p.toolCalls = scene.toolCalls
  p.particles = s.particles
  p.edges = s.edges
  p.discoveries = scene.discoveries
  p.simTime = s.currentTime
  p.links = resolveLinks(d.linksPropRef.current ?? s.links, p.agents, s.currentTime)
}

/**
 * The requestAnimationFrame loop of the canvas: scene sync, camera physics, overlay planning, all the
 * draw passes (bottom to top), the edge-bubble buttons, the tooltip position and the perf overlay.
 * The loop is set up once and always calls the latest draw through a ref.
 */
export function useCanvasDrawLoop(deps: DrawLoopDeps) {
  const { mainCanvasRef, dimensions } = deps
  const animationRef = useRef<number>(0)
  const timeRef = useRef(0)
  const bloomRef = useRef<BloomRenderer | null>(null)
  const depthParticlesRef = useRef<DepthParticle[]>([])
  const lastFrameTimeRef = useRef(0)
  const haloEaserRef = useRef(createHaloEaser())
  // Rate-limited error logging for the draw loop (avoid flooding console)
  const lastDrawErrorRef = useRef(0)
  const perfRef = useRef(createPerfStats())
  // Idle drawing (#216): a still scene is redrawn on change or at a low rate, not 60 times a second
  const gateRef = useRef(createDrawGate())
  const propsEpochRef = useRef({ props: null as object | null, epoch: 0 })
  // Caches for per-frame lookups — avoid rebuilding Set/Map every ~16ms
  const conflictCacheRef = useRef<{ files: Map<string, FileAttention> | undefined; conflicts: FileConflict[] }>({ files: undefined, conflicts: [] })
  const edgeLookupCacheRef = useRef<{
    particles: Particle[]
    edges: Edge[]
    activeEdgeIds: Set<string>
    edgeMap: Map<string, Edge>
  }>({ particles: [], edges: [], activeEdgeIds: new Set(), edgeMap: new Map() })
  // Delegation path (#56): restarts whenever the selected node changes
  const pathAnimRef = useRef(createPathAnimation())
  const drawOptsRef = useRef<DrawOpts>({ reducedMotion: false, zoom: 1, showCost: false, showStats: false })
  const repeatCacheRef = useRef<{ health?: unknown; waste?: unknown; agents?: unknown; marks: ReadonlyMap<string, RepeatMark> }>({ marks: new Map() })
  // Level of detail of the previous frame: the thresholds keep a hysteresis band so text does not blink (#378)
  const lodRef = useRef<DrawOpts['lod']>(undefined)
  // Stable ref so the rAF loop always calls the latest draw without re-subscribing
  const drawRef = useRef<(timestamp: number) => void>(() => {})

  useEffect(() => {
    bloomRef.current = new BloomRenderer(0.5)
    depthParticlesRef.current = createDepthParticles(dimensions.width, dimensions.height)
    return () => { bloomRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- particles created once, resized by draw loop
  }, [])

  // Any interaction (pointer, wheel, key, focus) brings the loop back to full rate for a moment
  useEffect(() => {
    const wake = () => gateRef.current.wake()
    // On the window, in the capture phase: the bubble buttons and the panels over the canvas count too
    const opts: AddEventListenerOptions = { passive: true, capture: true }
    const events = ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'wheel', 'keydown', 'keyup', 'focusin', 'resize']
    for (const e of events) window.addEventListener(e, wake, opts)
    const onVisible = () => { if (!document.hidden) gateRef.current.invalidate() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      for (const e of events) window.removeEventListener(e, wake, opts)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  /** Skip the frame when nothing moved (see draw-gate). Reads the raw simulation, so a skipped frame costs a few microseconds. */
  const frameIsRedundant = (timestamp: number): boolean => {
    if (PERF_BASELINE) return false
    const s = deps.simulationRef.current
    const p = deps.drawPropsRef.current
    const tracker = propsEpochRef.current
    if (tracker.props !== p) { tracker.props = p; tracker.epoch++ }
    const hover = deps.hoverTargetRef.current
    const focused = deps.hasFocusRef.current ? deps.focusedNodeRef.current : null
    const effects = deps.effectsRef.current.length
    const reducedMotion = deps.reducedMotionRef.current
    const stamp = sceneStamp({
      agents: s.agents.values(), toolCalls: s.toolCalls.values(),
      particles: s.particles.length, edges: s.edges.length, discoveries: s.discoveries.length, effects,
      transform: deps.transformRef.current, width: p.dimensions.width, height: p.dimensions.height, dpr: deps.dprRef.current,
      epoch: tracker.epoch,
      keys: [
        sceneTheme(), // a theme switch recolours the agent states: redraw a still scene
        p.selectedAgentId, p.hoveredAgentId, p.selectedToolCallId, p.selectedDiscoveryId, p.selectedLinkId,
        p.showStats, p.showHexGrid, !!p.showCostOverlay, !!p.isDragging, !!p.pauseAutoFit,
        hover?.type, hover?.id, focused?.type, focused?.id, deps.selectedClusterKeyRef.current,
        deps.hideInactiveRef.current, deps.neverHideRef.current, reducedMotion, s.isPlaying, deps.presentationRef.current.mask,
        MOTION_LAYERS.map(l => layerIsCalm(deps.globalReducedRef.current, deps.calmLayersRef.current, l) ? '1' : '0').join(''),
      ],
    })
    // A chip travelling to a file card (SEARCH_FLOW.chipWindowS after its Grep completed) keeps the full frame
    // rate, unless the links layer is calm (static line then). It reads the scene the last frame drew (p, filtered by
    // Hide inactive and closed branches, re-synced on every drawn frame), not the raw simulation: a hidden card draws nothing.
    const flowMoves = !layerIsCalm(deps.globalReducedRef.current, deps.calmLayersRef.current, 'links')
      && searchFlowMoves(p.discoveries, p.toolCalls, getToolCardSize, s.isPlaying ? s.currentTime : null)
    const animating = flowMoves || sceneAnimating(s.agents.values(), s.toolCalls.values(), s.particles.length, effects)
    const draw = gateRef.current.shouldDraw({ now: timestamp, stamp, reducedMotion, animating, moving: deps.isCameraBusy() || !!p.isDragging })
    if (!draw) perfRef.current.skippedFrames++
    return !draw
  }

  const draw = (timestamp: number) => {
    animationRef.current = requestAnimationFrame((ts) => drawRef.current(ts))

    const canvas = mainCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (frameIsRedundant(timestamp)) return
    const frameStart = performance.now()
    if (PERF_OVERLAY_ENABLED) { countPaintCalls(ctx, perfRef.current); perfRef.current.drawCalls = 0; perfRef.current.drawnFrames++ }

    try {
      syncSceneIntoDrawProps(deps)

      const {
        agents, toolCalls, particles, edges, discoveries,
        selectedAgentId, hoveredAgentId, showStats, showHexGrid,
        showCostOverlay, selectedToolCallId, selectedDiscoveryId, selectedLinkId,
        simTime, pauseAutoFit, dimensions, onAgentDrag,
        isDragging, links: resolvedLinks,
      } = deps.drawPropsRef.current
      const transform = deps.transformRef.current
      const reducedMotion = deps.reducedMotionRef.current
      const calmOf = (layer: MotionLayer) => layerIsCalm(deps.globalReducedRef.current, deps.calmLayersRef.current, layer)

      syncExpiryHold(deps, deps.drawPropsRef.current)

      const deltaTime = lastFrameTimeRef.current ? (timestamp - lastFrameTimeRef.current) / 1000 : ANIM_SPEED.defaultDeltaTime
      lastFrameTimeRef.current = timestamp
      // Reduced motion freezes the animation clock: every time-based wobble/pulse/scan stops
      if (!reducedMotion) timeRef.current += deltaTime
      if (simTime != null) deps.simTimeRef.current = simTime

      const dpr = deps.dprRef.current
      const w = dimensions.width
      const h = dimensions.height

      const backingW = Math.max(1, Math.round(w * dpr))
      const backingH = Math.max(1, Math.round(h * dpr))
      if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW
        canvas.height = backingH
        bloomRef.current?.resize(backingW, backingH)
      }
      // Reset every frame: cheap, and it keeps the scale correct after any backing-store resize
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const opts = drawOptsRef.current
      // The scene follows the theme (#381): agent states, labels, links, halos, cards and grid
      const theme = sceneTheme()
      opts.theme = theme
      opts.reducedMotion = reducedMotion
      opts.zoom = transform.scale
      const lod = lodForZoom(transform.scale, lodRef.current)
      lodRef.current = lod
      opts.lod = lod
      // Hit-testing sizes the discovery cards as this frame draws them (#378)
      frameLevel.lod = lod
      opts.showCost = !!showCostOverlay
      opts.showStats = showStats
      opts.showSessionLabels = hasSeveralSessions(agents.values())
      opts.teams = deps.teamsRef.current
      opts.focusedAgentId = deps.hasFocusRef.current && deps.focusedNodeRef.current?.type === 'agent' ? deps.focusedNodeRef.current.id : null
      opts.edgeBubbles = true
      opts.replayLost = deps.drawPropsRef.current.replayLost
      opts.simTime = deps.drawPropsRef.current.simTime
      opts.maskText = deps.presentationRef.current.mask
      // Loop / repeat badges (#377): re-derived only when the verdicts, the ledger or the drawn agents change
      {
        const health = deps.drawPropsRef.current.health
        const waste = deps.simulationRef.current?.waste
        const cache = repeatCacheRef.current
        if (cache.health !== health || cache.waste !== waste || cache.agents !== agents) {
          repeatCacheRef.current = { health, waste, agents, marks: repeatMarks(health, waste, agents.keys()) }
        }
        opts.repeatMarks = repeatCacheRef.current.marks
      }
      // Elements outside the viewport (with a margin) are not drawn; ?perf=full turns this off for baseline measurements
      opts.view = PERF_BASELINE ? undefined : viewRectFor(transform, w, h)

      deps.refreshInsetsIfStale(w, h, timestamp)
      // Camera physics (inertia + auto-fit)
      deps.updateCamera(isDragging, pauseAutoFit)

      // Floaty agent drag
      deps.updateDragLerp(agents, onAgentDrag)

      // Fleet clusters (one halo per session / team) and the collision-free placement of every text overlay
      const clusters = computeClusters(agents.values(), deps.teamsRef.current, { sessions: deps.sessionsRef.current, costAgents: costScope(deps.simulationRef.current).agents.values(), now: Date.now(), replayLost: opts.replayLost })
      // Halos follow the agents that appear, finish or get hidden without jumping (a snap under reduced motion)
      haloEaserRef.current.apply(clusters, deltaTime, reducedMotion)
      deps.clustersRef.current = clusters
      const workspaceZones = computeWorkspaceZones(clusters)
      // The header chips are the grip of the zones: hit-tested as drawn (same rect as drawWorkspaceZones)
      workspaceHeaderHits.rects = new Map(workspaceZones.map(z => [z.projectId, workspaceHeaderRect(z, transform.scale)]))
      const hoverTarget = deps.hoverTargetRef.current
      const hoveredLinkId = hoverTarget?.type === 'link' ? hoverTarget.id : null
      const edgeBubbles: KeyedEdgeBubble[] = []
      {
        ctx.font = `${EDGE_BUBBLE.fontSize}px monospace`
        const measure = (t: string) => measureTextCached(ctx, t)
        const heldKeys = deps.heldBubbleKeysRef.current
        for (const r of resolvedLinks) {
          const held = expiryHold.neverHide || expiryHold.paused || r.id === selectedLinkId || r.id === hoveredLinkId
          edgeBubbles.push(...selectEdgeBubbles(r, agents, simTime, { held, heldKeys, measure }))
        }
      }
      const cappedEdgeBubbles = capEdgeBubbles(edgeBubbles)
      const heldBubbleKeys = new Set<string>()
      for (const b of cappedEdgeBubbles) if (deps.heldBubbleKeysRef.current.has(b.key)) heldBubbleKeys.add(b.key)
      const overlay: OverlayPlanResult = (w > 0 && h > 0)
        ? planOverlays({
          agents, clusters, edgeBubbles: cappedEdgeBubbles, heldBubbleKeys,
          // Below 768 px the bubble zones are touch targets of 44 px (#514)
          touchTargetPx: typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY).matches ? TOUCH_TARGET_PX : 0,
          transform, viewport: { w, h }, safeArea: deps.getSafeArea(w, h), lod,
          showStats, showCost: !!showCostOverlay, showSessionLabels: !!opts.showSessionLabels,
          selectedAgentId, hoveredAgentId, focusedAgentId: opts.focusedAgentId ?? null,
          selectedLinkId, hoveredLinkId, simTime: deps.simTimeRef.current, teams: deps.teamsRef.current,
          isBubbleHeld: id => expiryHold.neverHide || expiryHold.paused || expiryHold.agentIds.has(id),
          // Cards are drawn above labels and bubbles: keep those texts off them (#378)
          toolCards: toolCardRects(toolCalls.values(), toolCardSize),
          // Halo titles move off the workspace headers and the collapsed Conversation pill (#378)
          workspaceZones, covers: deps.getCovers(), replayLost: opts.replayLost,
        })
        : EMPTY_PLAN
      if (overlay === EMPTY_PLAN) clearOverlayHits(); else setOverlayHits(overlay.hits)
      opts.plan = overlay === EMPTY_PLAN ? undefined : overlay.plan
      opts.crowded = overlay.crowded
      if (deps.hiddenAgentNamesRef) deps.hiddenAgentNamesRef.current = overlay.hiddenAgentNames
      const activeClusterKey = (selectedAgentId
        ? clusters.find(c => c.memberIds.includes(selectedAgentId))?.key
        : undefined) ?? deps.selectedClusterKeyRef.current
      const hoveredClusterKey = hoverTarget?.type === 'cluster' ? hoverTarget.id : null

      // Detect state changes → visual effects
      deps.detectStateChanges()

      // Update effects (mutate in place to avoid GC pressure)
      {
        const effects = deps.effectsRef.current
        let writeIdx = 0
        for (let i = 0; i < effects.length; i++) {
          effects[i].age += deltaTime
          if (effects[i].age < effects[i].duration) {
            if (writeIdx !== i) effects[writeIdx] = effects[i]
            writeIdx++
          }
        }
        effects.length = writeIdx
      }

      ctx.clearRect(0, 0, w, h)
      if (!calmOf('background')) updateDepthParticles(depthParticlesRef.current, deltaTime, w, h)

      let activeAgentPos: { x: number; y: number; color: string } | undefined
      for (const [, agent] of agents) {
        if (agent.state === 'thinking' || agent.state === 'tool_calling' || agent.state === 'waiting_permission') {
          activeAgentPos = { x: agent.x, y: agent.y, color: stateColor(agent.state, theme) }
          break
        }
      }

      drawBackground(ctx, w, h, depthParticlesRef.current, transform, showHexGrid, timeRef.current, activeAgentPos, calmOf('background'), theme)

      ctx.save()
      ctx.translate(transform.x, transform.y)
      ctx.scale(transform.scale, transform.scale)

      // Pre-compute shared lookup structures — cached across frames when inputs are unchanged
      const elCache = edgeLookupCacheRef.current
      let activeEdgeIds: Set<string>
      let edgeMap: Map<string, Edge>
      if (elCache.particles === particles && elCache.edges === edges) {
        activeEdgeIds = elCache.activeEdgeIds
        edgeMap = elCache.edgeMap
      } else {
        activeEdgeIds = getActiveEdgeIds(particles)
        edgeMap = buildEdgeMap(edges)
        edgeLookupCacheRef.current = { particles, edges, activeEdgeIds, edgeMap }
      }

      // Draw order (bottom to top) matches hit-test priority in reverse:
      // bubbles sit under tool/discovery cards so interactive cards are never covered.
      drawDiscoveryConnections(ctx, discoveries, agents, theme)
      // Team halos sit under everything; links (communication edges) under the nodes
      opts.reducedMotion = calmOf('links')
      drawWorkspaceZones(ctx, workspaceZones, opts)
      drawClusterHalos(ctx, clusters, activeClusterKey, opts)
      drawSessionLinks(ctx, sessionLinkSegments(clusters, deps.sessionLinksRef.current ?? []), opts)
      drawPhaseLabels(ctx, phaseLabels(agents.values()), opts)
      drawEdges(ctx, edges, agents, toolCalls, activeEdgeIds, timeRef.current, opts)
      {
        const pathTarget = selectedAgentId ?? selectedToolCallId ?? null
        const elapsed = pathAnimRef.current.elapsed(pathTarget, timestamp)
        if (elapsed !== null) drawDelegationPath(ctx, delegationPathEdges(pathTarget, edges), agents, toolCalls, elapsed, opts.reducedMotion)
      }
      {
        // Re-derived only when the simulation hands over a new file map (it keeps the same one otherwise)
        const files = deps.simulationRef.current?.fileAttention
        const cache = conflictCacheRef.current
        if (cache.files !== files) conflictCacheRef.current = { files, conflicts: files ? deriveFileConflicts(files) : [] }
        drawFileConflicts(ctx, fileConflictSegments(conflictCacheRef.current.conflicts, agents), opts)
      }
      drawLinks(
        ctx, resolvedLinks, agents, selectedLinkId,
        deps.hoverTargetRef.current?.type === 'link' ? deps.hoverTargetRef.current.id : null,
        timeRef.current, opts,
      )
      drawSearchFlow(ctx, searchFlowSegments(discoveries, toolCalls, getToolCardSize, deps.simulationRef.current.isPlaying ? deps.simTimeRef.current : null), timeRef.current, opts)
      opts.reducedMotion = calmOf('agents')
      drawAgents(ctx, agents, selectedAgentId, hoveredAgentId, showStats, timeRef.current, opts)
      drawBranchBadges(ctx, agents, deps.drawPropsRef.current.collapse, opts.focusedAgentId ?? null, opts)
      drawEdgeBubbles(ctx, cappedEdgeBubbles, selectedLinkId, hoveredLinkId, opts)
      drawMessageBubblesWorld(ctx, agents, deps.simTimeRef.current, opts)
      drawToolCalls(ctx, toolCalls, timeRef.current, selectedToolCallId, opts)
      drawDiscoveries(ctx, discoveries, agents, selectedDiscoveryId, opts)
      if (showCostOverlay) drawCostLabels(ctx, agents, toolCalls, opts)
      opts.reducedMotion = calmOf('effects')
      drawParticles(ctx, particles, edgeMap, agents, toolCalls, timeRef.current, opts)
      if (!opts.reducedMotion) drawEffects(ctx, deps.effectsRef.current)
      opts.reducedMotion = reducedMotion

      // Keyboard focus ring (distinct from hover/selection glow)
      const focusedNow = deps.hasFocusRef.current ? deps.focusedNodeRef.current : null
      if (focusedNow) {
        const shape = focusShapeFor(focusedNow, deps.drawPropsRef.current, discoveryCardScale(opts))
        if (shape) drawFocusRing(ctx, shape, transform.scale)
      }

      ctx.restore()

      // Cluster labels live in screen space: readable at any zoom, placed without overlap
      drawClusterLabels(ctx, clusters, opts.plan, activeClusterKey, hoveredClusterKey, opts)

      // Focusable buttons over the edge bubbles, at the places the overlay plan chose
      if (deps.bubbleLayerRef.current) {
        const specs: BubbleButtonSpec[] = []
        if (opts.plan && lod.details) {
          for (const b of cappedEdgeBubbles) {
            const place = opts.plan.get(planKey.edgeBubble(b.key))
            if (!place || place.hidden || !place.rect) continue
            specs.push({
              key: b.key, linkId: b.linkId, messageId: b.messageId,
              label: place.collapsed && b.groupCount > 1 ? `${b.ariaLabel}, and ${b.groupCount - 1} more on this link` : b.ariaLabel,
              x: place.rect.x, y: place.rect.y, w: place.rect.w, h: place.rect.h, collapsed: place.collapsed,
            })
          }
        }
        syncBubbleButtons(deps.bubbleLayerRef.current, specs)
      }

      if (showCostOverlay) { const cost = costScope(deps.simulationRef.current); drawCostSummaryPanel(ctx, cost.agents, cost.toolCalls, cost.unattributed, deps.presentationRef.current.mask, deps.drawPropsRef.current.replayLost) }
      if (bloomRef.current && !calmOf('effects')) bloomRef.current.apply(canvas, ctx)

      // Tooltip follows its node without React re-renders
      positionTooltip(deps.tooltipRef.current, transform, w, h, deps.drawPropsRef.current, deps.tooltipTargetRef.current)

      // Performance overlay (enabled via ?perf or ?stress)
      if (PERF_OVERLAY_ENABLED) {
        drawPerfOverlay(ctx, perfRef.current, frameStart, {
          agents: agents.size, toolCalls: toolCalls.size, particles: particles.length, edges: edges.length, discoveries: discoveries.length,
        }, PERF_BASELINE)
      }
    } catch (err) {
      // Log at most once every 5s to avoid flooding the console
      const now = Date.now()
      if (now - lastDrawErrorRef.current > 5000) {
        lastDrawErrorRef.current = now
        console.warn('[AgentCanvas] draw error:', err)
      }
    }
  }

  drawRef.current = draw

  useEffect(() => {
    const loop = (timestamp: number) => drawRef.current(timestamp)
    animationRef.current = requestAnimationFrame(loop)
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- drawRef is stable; rAF loop set up once
  }, [])
}
