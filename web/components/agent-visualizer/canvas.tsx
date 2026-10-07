'use client'

import { useRef, useEffect, useState, useCallback } from 'react'
import { Agent, Particle, Edge, Discovery, DepthParticle } from '@/lib/agent-types'
import type { TeamSummary } from '@/lib/agent-types'
import type { SimulationState, AgentLink } from '@/hooks/simulation/types'
import { COLORS } from '@/lib/colors'
import {
  ANIM_SPEED, PERF_OVERLAY, PERF_OVERLAY_ENABLED, A11Y_SNAPSHOT_MS, FLASH_MAX_PER_SECOND,
  ANIM_PAUSE_KEY, NEVER_HIDE_KEY, CAMERA, STATE_LABEL_LONG, EDGE_BUBBLE, expiryHold, getDiscoveryCardDimensions,
} from '@/lib/canvas-constants'
import { formatModelName } from '@/lib/utils'
import { BloomRenderer } from './bloom-renderer'
import { createDepthParticles, updateDepthParticles, drawBackground } from './background-layer'
import {
  type VisualEffect,
  drawTetherLine,
  drawEffects,
  drawAgents,
  drawMessageBubblesWorld,
  drawEdges, getActiveEdgeIds,
  drawParticles, buildEdgeMap,
  drawToolCalls,
  drawDiscoveries, drawDiscoveryConnections,
  drawCostLabels, drawCostSummaryPanel,
  detectStateChanges as detectStateChangesPure,
  drawFocusRing, focusShapeFor, toolCardSize, stateColor, lodForZoom,
  drawLinks, drawEdgeBubbles, drawClusterHalos, drawClusterLabels, resolveLinks, hasSeveralSessions,
  computeClusters, planOverlays, selectEdgeBubble, setOverlayHits, clearOverlayHits, EMPTY_PLAN,
  type Cluster, type SessionMeta, type EdgeBubble, type OverlayPlanResult,
  detectTeamChanges, createTeamPrev, type TeamPrev, type ResolvedLink,
  createFlashLimiter, buildA11yModel, enqueueAnnouncements, createAnnouncementQueue, a11yRecorder,
  type AnnouncementItem, type AnnouncementQueue,
  type DrawOpts, type HitTarget, type CommEntry, type A11yModel,
} from './canvas/index'
import { agentStatusText, teammateActivity, cleanText, agentDrawRadius } from './canvas/team-style'
import { measureTextCached } from './canvas/render-cache'
import { measureOverlayInsets } from './canvas/overlay-insets'
import { safeRect, NO_INSETS, type Insets } from './canvas/camera-fit'
import { visibleAgents } from '@/lib/inactive-agents'
import { createCollapseMemory, evaluateCollapse, applyCollapse, toggleBranch, type CollapseMemory, type CollapseView } from './canvas/branch-collapse'
import { drawBranchBadges } from './canvas/draw-branch-badges'
import { buildNodeOrder, sameNode, type NavNode } from './canvas/keyboard-nav'
import { GraphA11yList } from './graph-a11y-list'
import { GraphLegend } from './graph-legend'
import { useCanvasCamera } from '@/hooks/use-canvas-camera'
import { useCanvasInteraction } from '@/hooks/use-canvas-interaction'

interface CanvasProps {
  /** Identity of the selected tab (session id, 'all', team): a change refits the camera */
  scopeKey?: string
  /** Ref to simulation state — read every frame without React re-renders */
  simulationRef: React.RefObject<SimulationState>
  selectedAgentId: string | null
  hoveredAgentId: string | null
  showStats: boolean
  showHexGrid: boolean
  zoomToFitTrigger?: number
  pauseAutoFit?: boolean
  /** `modifiers.shiftKey` is set for a Shift-click (pair filter: click one agent, Shift-click another) */
  onAgentClick: (agentId: string | null, modifiers?: { shiftKey: boolean }) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  selectedToolCallId?: string | null
  onDiscoveryClick?: (discoveryId: string | null) => void
  selectedDiscoveryId?: string | null
  showCostOverlay?: boolean
  /** Hide idle / complete agents (the selected agent and the parents of visible agents stay) */
  hideInactive?: boolean
  /** Communication links between agents (spawn / teammate). Defaults to the simulation's own links. */
  links?: Map<string, AgentLink>
  /** Agent Teams (halo colours, legend) */
  teams?: Map<string, TeamSummary>
  /** A link (edge or count badge) was clicked */
  onLinkClick?: (linkId: string) => void
  selectedLinkId?: string | null
  /** Facts about sessions the agents do not carry (workspace, label, runtime), keyed by session id: shown on the cluster labels */
  sessions?: ReadonlyMap<string, SessionMeta>
  /**
   * A cluster label (or its outline entry) was activated: the canvas has already zoomed to the cluster;
   * the app can also select the session / team (e.g. its session tab).
   */
  onClusterSelect?: (cluster: { key: string; kind: 'session' | 'team'; sessionIds: string[]; teamName?: string }) => void
}

const EMPTY_MODEL: A11yModel = { summary: 'Agent graph: no agents yet', agents: [], discoveries: [], teams: [], links: [], clusters: [] }

const EMPTY_COLLAPSE: CollapseView = { branches: new Map(), hidden: new Set() }

/**
 * Agents to draw: the 'hide inactive' filter, then the automatic collapse of inactive sub-trees.
 * Only the selected agent keeps a branch open (hovering must not make the graph jump).
 */
function sceneAgents(
  all: Map<string, Agent>, hideInactive: boolean, keepIds: ReadonlyArray<string | null | undefined>,
  selectedId: string | null, memory: CollapseMemory,
): { agents: Map<string, Agent>; collapse: CollapseView } {
  const base = visibleAgents(all, hideInactive, keepIds)
  const collapse = evaluateCollapse(base, memory, [selectedId])
  return { agents: applyCollapse(base, collapse), collapse }
}

function readStoredFlag(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1' } catch { return false }
}
function writeStoredFlag(key: string, value: boolean): void {
  try { window.localStorage.setItem(key, value ? '1' : '0') } catch { /* storage unavailable */ }
}

const CONTROL_BUTTON_CLASS =
  'inline-flex min-h-6 min-w-6 items-center justify-center rounded-md px-2 py-1 text-[11px] font-mono '
  + 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-60'

export function AgentCanvas({
  simulationRef,
  selectedAgentId, hoveredAgentId, showStats, showHexGrid, zoomToFitTrigger, pauseAutoFit,
  onAgentClick, onAgentHover, onAgentDrag, onContextMenu, onToolCallClick, selectedToolCallId, onDiscoveryClick, selectedDiscoveryId, showCostOverlay, hideInactive = false,
  links: linksProp, teams, onLinkClick, selectedLinkId, sessions, onClusterSelect, scopeKey,
}: CanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mainCanvasRef = useRef<HTMLCanvasElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const animationRef = useRef<number>(0)
  const timeRef = useRef(0)
  const simTimeRef = useRef(0)
  const bloomRef = useRef<BloomRenderer | null>(null)
  const depthParticlesRef = useRef<DepthParticle[]>([])
  const lastFrameTimeRef = useRef(0)
  const dprRef = useRef(1)

  // Effects system
  const effectsRef = useRef<VisualEffect[]>([])
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())
  const flashLimiterRef = useRef(createFlashLimiter(FLASH_MAX_PER_SECOND))

  // Rate-limited error logging for the draw loop (avoid flooding console)
  const lastDrawErrorRef = useRef(0)

  // Performance overlay state
  const perfRef = useRef({
    frames: 0,
    lastFpsUpdate: 0,
    fps: 0,
    frameTimeMs: 0,
    frameTimes: [] as number[],
    p95: 0,
  })

  // Caches for per-frame lookups — avoid rebuilding Set/Map every ~16ms
  const edgeLookupCacheRef = useRef<{
    particles: Particle[]
    edges: Edge[]
    activeEdgeIds: Set<string>
    edgeMap: Map<string, Edge>
  }>({ particles: [], edges: [], activeEdgeIds: new Set(), edgeMap: new Map() })

  // ─── Motion preferences ─────────────────────────────────────────────────
  // OS preference (read once + change listener) OR the visible "Pause animations" toggle.
  const [osReducedMotion, setOsReducedMotion] = useState(false)
  const [animationsPaused, setAnimationsPaused] = useState(false)
  const [neverHide, setNeverHide] = useState(false)
  const reducedMotionRef = useRef(false)
  reducedMotionRef.current = osReducedMotion || animationsPaused
  const animationsPausedRef = useRef(false)
  animationsPausedRef.current = animationsPaused
  const neverHideRef = useRef(false)
  neverHideRef.current = neverHide

  useEffect(() => {
    // Stored preferences are read after mount so server and first client render match
    setAnimationsPaused(readStoredFlag(ANIM_PAUSE_KEY))
    setNeverHide(readStoredFlag(NEVER_HIDE_KEY))
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    setOsReducedMotion(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setOsReducedMotion(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const toggleAnimationsPaused = useCallback(() => {
    setAnimationsPaused(prev => { writeStoredFlag(ANIM_PAUSE_KEY, !prev); return !prev })
  }, [])
  const toggleNeverHide = useCallback(() => {
    setNeverHide(prev => { writeStoredFlag(NEVER_HIDE_KEY, !prev); return !prev })
  }, [])

  // ─── Keyboard focus + accessible mirror state ───────────────────────────
  const [focusedNode, setFocusedNode] = useState<NavNode | null>(null)
  const focusedNodeRef = useRef<NavNode | null>(null)
  focusedNodeRef.current = focusedNode
  const [hasFocus, setHasFocus] = useState(false)
  const hasFocusRef = useRef(false)
  hasFocusRef.current = hasFocus
  const hoverTargetRef = useRef<HitTarget | null>(null)
  const tooltipTargetRef = useRef<NavNode | null>(null)

  const [a11yModel, setA11yModel] = useState<A11yModel>(EMPTY_MODEL)
  const [communications, setCommunications] = useState<CommEntry[]>([])
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
  const announcementsRef = useRef<AnnouncementQueue>(createAnnouncementQueue())
  const a11ySignatureRef = useRef('')
  const teamPrevRef = useRef<TeamPrev>(createTeamPrev())
  // Props read by the draw loop and the snapshot timer without re-subscribing
  const linksPropRef = useRef(linksProp)
  linksPropRef.current = linksProp
  const teamsRef = useRef(teams)
  teamsRef.current = teams
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const onClusterSelectRef = useRef(onClusterSelect)
  onClusterSelectRef.current = onClusterSelect
  /** Clusters and overlay plan of the last drawn frame (read by the cluster click handler) */
  const clustersRef = useRef<Cluster[]>([])
  const [selectedClusterKey, setSelectedClusterKey] = useState<string | null>(null)
  const selectedClusterKeyRef = useRef<string | null>(null)
  selectedClusterKeyRef.current = selectedClusterKey

  const handleFocusedNodeChange = useCallback((node: NavNode | null) => {
    setFocusedNode(prev => (sameNode(prev, node) ? prev : node))
  }, [])

  const handleHoverTargetChange = useCallback((target: HitTarget | null) => {
    hoverTargetRef.current = target
  }, [])

  // ─── Stable refs for animation loop & event handlers ────────────────────
  // Simulation data (agents, particles, etc.) is synced from simulationRef
  // at the top of each draw frame, so it's always fresh even without re-renders.
  const sim = simulationRef.current
  const hideInactiveRef = useRef(hideInactive)
  hideInactiveRef.current = hideInactive
  // Collapse of inactive sub-trees: the user's choices live here for the life of the canvas
  const collapseMemoryRef = useRef<CollapseMemory>(createCollapseMemory())
  const collapseViewRef = useRef<CollapseView>(EMPTY_COLLAPSE)
  const handleToggleBranch = useCallback((id: string) => {
    toggleBranch(collapseMemoryRef.current, collapseViewRef.current, id)
  }, [])
  const makeDrawProps = (prev?: { isDragging: boolean; links: ResolvedLink[] }) => {
    const scene = sceneAgents(sim.agents, hideInactive, [selectedAgentId, hoveredAgentId], selectedAgentId, collapseMemoryRef.current)
    collapseViewRef.current = scene.collapse
    return {
    agents: scene.agents, collapse: scene.collapse, onToggleBranch: handleToggleBranch, toolCalls: sim.toolCalls,
    particles: sim.particles, edges: sim.edges, discoveries: sim.discoveries,
    selectedAgentId, hoveredAgentId, showStats, showHexGrid,
    showCostOverlay, selectedToolCallId, selectedDiscoveryId, selectedLinkId,
    simTime: sim.currentTime, pauseAutoFit, dimensions,
    // Resolved by the draw loop each frame; carried over so a pointer event between a render and the
    // next frame still hit-tests against the links of the previous frame (never an empty list)
    links: prev?.links ?? ([] as ResolvedLink[]),
    onAgentDrag, onAgentClick, onAgentHover, onContextMenu,
    onToolCallClick, onDiscoveryClick, onLinkClick,
    onClusterClick: (key: string) => handleClusterClickRef.current(key),
    isDragging: prev?.isDragging ?? false,
    }
  }
  const handleClusterClickRef = useRef<(key: string) => void>(() => {})
  const drawPropsRef = useRef(makeDrawProps())
  drawPropsRef.current = makeDrawProps(drawPropsRef.current)

  // Insets of the UI overlaid on the canvas (top bar / tabs, control bar, open panels): re-measured
  // every few frames and on resize, read by the camera fit and by the cluster label clamp.
  const insetsRef = useRef<Insets>({ ...NO_INSETS })
  const insetsFrameRef = useRef(0)
  const getInsets = useCallback(() => insetsRef.current, [])
  const insetsSizeRef = useRef({ w: 0, h: 0 })
  const safeAreaCacheRef = useRef<{ insets: Insets; w: number; h: number; rect: ReturnType<typeof safeRect> } | null>(null)
  const refreshInsets = useCallback(() => {
    insetsRef.current = measureOverlayInsets(mainCanvasRef.current)
  }, [])
  /** Safe area of the viewport, recomputed only when the insets or the viewport change (not per frame) */
  const getSafeArea = useCallback((w: number, h: number) => {
    const c = safeAreaCacheRef.current
    const i = insetsRef.current
    if (c && c.insets === i && c.w === w && c.h === h) return c.rect
    const rect = safeRect({ width: w, height: h }, i)
    safeAreaCacheRef.current = { insets: i, w, h, rect }
    return rect
  }, [])

  // ─── Camera ─────────────────────────────────────────────────────────────
  const {
    transformRef, userHasNavigatedRef, panVelocityRef,
    screenToCanvas, doZoomToFit, updateCamera, zoomBy, panBy, canvasToScreen, ensureVisible, zoomToCircle,
  } = useCanvasCamera({
    mainCanvasRef, drawPropsRef, simTimeRef, dimensions,
    agentCount: sim.agents.size, zoomToFitTrigger, selectedAgentId,
    clustersRef, getInsets, scopeKey,
  })

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

  // ─── Setup ──────────────────────────────────────────────────────────────

  useEffect(() => {
    bloomRef.current = new BloomRenderer(0.5)
    depthParticlesRef.current = createDepthParticles(dimensions.width, dimensions.height)
    return () => { bloomRef.current = null }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- particles created once, resized by draw loop
  }, [])

  // Size + devicePixelRatio tracking. The ratio changes with browser zoom and when the window
  // moves between screens, so it is re-read on resize, via the observer, and on the
  // resolution media query (which fires when the ratio changes). The draw loop resizes the
  // backing store (and the bloom buffers) whenever it no longer matches.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    dprRef.current = window.devicePixelRatio || 1
    const observer = new ResizeObserver((entries) => {
      dprRef.current = window.devicePixelRatio || 1
      for (const entry of entries) {
        setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height })
      }
    })
    observer.observe(container)

    let mql: MediaQueryList | null = null
    const onDprChange = () => {
      dprRef.current = window.devicePixelRatio || 1
      watchResolution()
    }
    const watchResolution = () => {
      mql?.removeEventListener('change', onDprChange)
      if (typeof window.matchMedia !== 'function') return
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      mql.addEventListener('change', onDprChange)
    }
    watchResolution()
    window.addEventListener('resize', onDprChange)

    return () => {
      observer.disconnect()
      mql?.removeEventListener('change', onDprChange)
      window.removeEventListener('resize', onDprChange)
    }
  }, [])

  // ─── Accessible mirror: throttled snapshot of the simulation ───────────
  useEffect(() => {
    const snapshot = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      const s = simulationRef.current
      // Tool calls and communications are recorded per frame by the simulation step (a11yRecorder);
      // this timer only publishes them to React state.
      const scene = sceneAgents(s.agents, hideInactiveRef.current, [drawPropsRef.current.selectedAgentId], drawPropsRef.current.selectedAgentId, collapseMemoryRef.current)
      collapseViewRef.current = scene.collapse
      const model = buildA11yModel(scene.agents, s.toolCalls, s.discoveries, a11yRecorder.tools, {
        links: linksPropRef.current ?? s.links, edges: s.edges, collapse: scene.collapse, teams: teamsRef.current, simTime: s.currentTime,
        sessions: sessionsRef.current,
      })
      const comms = Array.from(a11yRecorder.comms.values())
      const signature = JSON.stringify([model, comms.length, comms[comms.length - 1]?.id])
      if (signature === a11ySignatureRef.current) return
      a11ySignatureRef.current = signature
      setA11yModel(model)
      setCommunications(comms)
    }
    snapshot()
    const timer = window.setInterval(snapshot, A11Y_SNAPSHOT_MS)
    return () => {
      window.clearInterval(timer)
      // Do not leak holds into the next mount (module-level singleton)
      expiryHold.neverHide = false
      expiryHold.paused = false
      expiryHold.agentIds.clear()
      expiryHold.toolIds.clear()
      expiryHold.discoveryIds.clear()
    }
  }, [simulationRef])

  // ─── Detect state changes → spawn effects + live-region announcements ───

  const detectStateChanges = useCallback(() => {
    const { agents, toolCalls } = drawPropsRef.current
    const { effects, transitions, newAgentStates, newToolStates } = detectStateChangesPure(
      agents, toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
    )
    if (!reducedMotionRef.current) {
      // Global flash limiter: at most FLASH_MAX_PER_SECOND bright flashes per second
      for (const fx of effects) {
        if ((fx.type === 'spawn' || fx.type === 'complete') && !flashLimiterRef.current.allow(performance.now())) {
          fx.noFlash = true
        }
      }
      effectsRef.current.push(...effects)
    } else {
      // Reduced motion: state changes are instant, no transient effects
      effectsRef.current.length = 0
    }
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates

    // Teammate activity changes ("<name> is idle") and new link messages ("<from> sent a message to <to>")
    const team = detectTeamChanges(agents, linksPropRef.current ?? simulationRef.current.links, teamPrevRef.current)
    teamPrevRef.current = team.next
    transitions.push(...team.transitions)

    if (transitions.length > 0) {
      const next = enqueueAnnouncements(announcementsRef.current, transitions)
      if (next !== announcementsRef.current) {
        announcementsRef.current = next
        setAnnouncements(next.items)
      }
    }
  }, [simulationRef])

  // ─── Main draw loop ────────────────────────────────────────────────────

  // Stable ref so the rAF loop always calls the latest draw without
  // re-subscribing when the callback identity changes.
  const drawRef = useRef<(timestamp: number) => void>(() => {})
  const drawOptsRef = useRef<DrawOpts>({ reducedMotion: false, zoom: 1, showCost: false, showStats: false })

  const draw = useCallback((timestamp: number) => {
    animationRef.current = requestAnimationFrame((ts) => drawRef.current(ts))

    const canvas = mainCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    try {
      // Sync simulation data from ref — always fresh, independent of React renders
      {
        const s = simulationRef.current
        const p = drawPropsRef.current
        const scene = sceneAgents(s.agents, hideInactiveRef.current, [p.selectedAgentId, p.hoveredAgentId], p.selectedAgentId, collapseMemoryRef.current)
        collapseViewRef.current = scene.collapse
        p.agents = scene.agents
        p.collapse = scene.collapse
        p.toolCalls = s.toolCalls
        p.particles = s.particles
        p.edges = s.edges
        p.discoveries = s.discoveries
        p.simTime = s.currentTime
        p.links = resolveLinks(linksPropRef.current ?? s.links, p.agents, s.currentTime)
      }

      const {
        agents, toolCalls, particles, edges, discoveries,
        selectedAgentId, hoveredAgentId, showStats, showHexGrid,
        showCostOverlay, selectedToolCallId, selectedDiscoveryId, selectedLinkId,
        simTime, pauseAutoFit, dimensions, onAgentDrag,
        isDragging, links: resolvedLinks,
      } = drawPropsRef.current
      const transform = transformRef.current
      const reducedMotion = reducedMotionRef.current

      // Expiry hold: hovered / focused elements, paused playback or animations, and the
      // "never hide" setting stop bubbles, tool cards and discoveries from expiring.
      {
        const focused = hasFocusRef.current ? focusedNodeRef.current : null
        const hover = hoverTargetRef.current
        expiryHold.neverHide = neverHideRef.current
        expiryHold.paused = animationsPausedRef.current || !simulationRef.current.isPlaying
        expiryHold.agentIds.clear()
        expiryHold.toolIds.clear()
        expiryHold.discoveryIds.clear()
        if (hoveredAgentId) expiryHold.agentIds.add(hoveredAgentId)
        if (hover?.type === 'agent' || hover?.type === 'bubble') expiryHold.agentIds.add(hover.id)
        if (hover?.type === 'tool') expiryHold.toolIds.add(hover.id)
        if (hover?.type === 'discovery') expiryHold.discoveryIds.add(hover.id)
        if (focused?.type === 'agent') expiryHold.agentIds.add(focused.id)
        if (focused?.type === 'tool') expiryHold.toolIds.add(focused.id)
        if (focused?.type === 'discovery') expiryHold.discoveryIds.add(focused.id)
        if (selectedToolCallId) expiryHold.toolIds.add(selectedToolCallId)
        if (selectedDiscoveryId) expiryHold.discoveryIds.add(selectedDiscoveryId)
      }

      const deltaTime = lastFrameTimeRef.current ? (timestamp - lastFrameTimeRef.current) / 1000 : ANIM_SPEED.defaultDeltaTime
      lastFrameTimeRef.current = timestamp
      // Reduced motion freezes the animation clock: every time-based wobble/pulse/scan stops
      if (!reducedMotion) timeRef.current += deltaTime
      if (simTime != null) simTimeRef.current = simTime

      const dpr = dprRef.current
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
      opts.reducedMotion = reducedMotion
      opts.zoom = transform.scale
      opts.showCost = !!showCostOverlay
      opts.showStats = showStats
      opts.showSessionLabels = hasSeveralSessions(agents.values())
      opts.teams = teamsRef.current
      opts.focusedAgentId = hasFocusRef.current && focusedNodeRef.current?.type === 'agent' ? focusedNodeRef.current.id : null
      opts.edgeBubbles = true

      // Overlay insets are cached: re-measured when the canvas is resized and, for panels opening or
      // closing without a resize, once per second (DOM reads force layout, so never per frame)
      if (insetsFrameRef.current === 0 || insetsSizeRef.current.w !== w || insetsSizeRef.current.h !== h || timestamp - insetsFrameRef.current > 1000) {
        insetsFrameRef.current = timestamp || 1
        insetsSizeRef.current = { w, h }
        refreshInsets()
      }
      // Camera physics (inertia + auto-fit)
      updateCamera(isDragging, pauseAutoFit)

      // Floaty agent drag
      updateDragLerp(agents, onAgentDrag)

      // Fleet clusters (one halo per session / team) and the collision-free placement of every text overlay
      const clusters = computeClusters(agents.values(), teamsRef.current, { sessions: sessionsRef.current })
      clustersRef.current = clusters
      const hoverTarget = hoverTargetRef.current
      const hoveredLinkId = hoverTarget?.type === 'link' ? hoverTarget.id : null
      const edgeBubbles: EdgeBubble[] = []
      {
        ctx.font = `${EDGE_BUBBLE.fontSize}px monospace`
        const measure = (t: string) => measureTextCached(ctx, t)
        for (const r of resolvedLinks) {
          const held = expiryHold.neverHide || expiryHold.paused || r.id === selectedLinkId || r.id === hoveredLinkId
          const b = selectEdgeBubble(r, agents, simTime, held, measure)
          if (b) edgeBubbles.push(b)
        }
      }
      const overlay: OverlayPlanResult = (w > 0 && h > 0)
        ? planOverlays({
          agents, clusters, edgeBubbles, transform, viewport: { w, h }, safeArea: getSafeArea(w, h), lod: lodForZoom(transform.scale),
          showStats, showCost: !!showCostOverlay, showSessionLabels: !!opts.showSessionLabels,
          selectedAgentId, hoveredAgentId, focusedAgentId: opts.focusedAgentId ?? null,
          selectedLinkId, hoveredLinkId, simTime: simTimeRef.current, teams: teamsRef.current,
          isBubbleHeld: id => expiryHold.neverHide || expiryHold.paused || expiryHold.agentIds.has(id),
        })
        : EMPTY_PLAN
      if (overlay === EMPTY_PLAN) clearOverlayHits(); else setOverlayHits(overlay.hits)
      opts.plan = overlay === EMPTY_PLAN ? undefined : overlay.plan
      opts.crowded = overlay.crowded
      const activeClusterKey = (selectedAgentId
        ? clusters.find(c => c.memberIds.includes(selectedAgentId))?.key
        : undefined) ?? selectedClusterKeyRef.current
      const hoveredClusterKey = hoverTarget?.type === 'cluster' ? hoverTarget.id : null

      // Detect state changes → visual effects
      detectStateChanges()

      // Update effects (mutate in place to avoid GC pressure)
      {
        const effects = effectsRef.current
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
      if (!reducedMotion) updateDepthParticles(depthParticlesRef.current, deltaTime, w, h)

      let activeAgentPos: { x: number; y: number; color: string } | undefined
      for (const [, agent] of agents) {
        if (agent.state === 'thinking' || agent.state === 'tool_calling' || agent.state === 'waiting_permission') {
          activeAgentPos = { x: agent.x, y: agent.y, color: stateColor(agent.state) }
          break
        }
      }

      drawBackground(ctx, w, h, depthParticlesRef.current, transform, showHexGrid, timeRef.current, activeAgentPos, reducedMotion)

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
      drawDiscoveryConnections(ctx, discoveries, agents)
      // Team halos sit under everything; links (communication edges) under the nodes
      drawClusterHalos(ctx, clusters, activeClusterKey, opts)
      drawEdges(ctx, edges, agents, toolCalls, activeEdgeIds, timeRef.current, opts)
      drawLinks(
        ctx, resolvedLinks, agents, selectedLinkId,
        hoverTargetRef.current?.type === 'link' ? hoverTargetRef.current.id : null,
        timeRef.current, opts,
      )
      drawAgents(ctx, agents, selectedAgentId, hoveredAgentId, showStats, timeRef.current, opts)
      drawBranchBadges(ctx, agents, drawPropsRef.current.collapse, opts.focusedAgentId ?? null, opts)
      drawEdgeBubbles(ctx, edgeBubbles, selectedLinkId, hoveredLinkId, opts)
      drawMessageBubblesWorld(ctx, agents, simTimeRef.current, opts)
      drawToolCalls(ctx, toolCalls, timeRef.current, selectedToolCallId, opts)
      drawDiscoveries(ctx, discoveries, agents, selectedDiscoveryId, opts)
      if (showCostOverlay) drawCostLabels(ctx, agents, toolCalls, opts)
      drawParticles(ctx, particles, edgeMap, agents, toolCalls, timeRef.current, opts)
      drawEffects(ctx, effectsRef.current)

      // Tether from the selected node to its detail card
      if (selectedAgentId) {
        const agent = agents.get(selectedAgentId)
        if (agent) drawTetherLine(ctx, agent, transform, h)
      } else if (selectedToolCallId) {
        const tool = toolCalls.get(selectedToolCallId)
        if (tool) drawTetherLine(ctx, tool, transform, h, toolCardSize(tool).w / 2)
      } else if (selectedDiscoveryId) {
        const disc = discoveries.find(d => d.id === selectedDiscoveryId)
        if (disc) drawTetherLine(ctx, disc, transform, h, getDiscoveryCardDimensions(disc.label, disc.content.split('\n')).cardW / 2)
      }

      // Keyboard focus ring (distinct from hover/selection glow)
      const focusedNow = hasFocusRef.current ? focusedNodeRef.current : null
      if (focusedNow) {
        const shape = focusShapeFor(focusedNow, drawPropsRef.current)
        if (shape) drawFocusRing(ctx, shape, transform.scale)
      }

      ctx.restore()

      // Cluster labels live in screen space: readable at any zoom, placed without overlap
      drawClusterLabels(ctx, clusters, opts.plan, activeClusterKey, hoveredClusterKey)

      if (showCostOverlay) drawCostSummaryPanel(ctx, agents, toolCalls)
      if (bloomRef.current && !reducedMotion) bloomRef.current.apply(canvas, ctx)

      // Tooltip follows its node without React re-renders
      positionTooltip(tooltipRef.current, transform, w, h, drawPropsRef.current, tooltipTargetRef.current)

      // ─── Performance overlay (enabled via ?perf or ?stress) ──────────
      if (PERF_OVERLAY_ENABLED) {
        const perf = perfRef.current
        const frameEnd = performance.now()
        const frameMs = frameEnd - (timestamp || frameEnd)
        perf.frameTimes.push(frameMs)
        if (perf.frameTimes.length > PERF_OVERLAY.maxFrameSamples) perf.frameTimes.shift()
        perf.frames++
        perf.frameTimeMs = frameMs
        if (frameEnd - perf.lastFpsUpdate >= PERF_OVERLAY.updateIntervalMs) {
          perf.fps = perf.frames
          perf.frames = 0
          perf.lastFpsUpdate = frameEnd
          const sorted = [...perf.frameTimes].sort((a, b) => a - b)
          perf.p95 = sorted[Math.floor(sorted.length * 0.95)] || 0
        }
        const po = PERF_OVERLAY
        const textX = po.x + po.padding
        let textY = po.y + po.lineHeight + 2
        ctx.save()
        ctx.fillStyle = po.bgColor
        ctx.fillRect(po.x, po.y, po.width, po.height)
        ctx.font = po.font
        ctx.fillStyle = perf.fps < po.fpsWarning ? po.fpsWarningColor : perf.fps < po.fpsCaution ? po.fpsCautionColor : po.fpsGoodColor
        ctx.fillText(`FPS: ${perf.fps}`, textX, textY); textY += po.lineHeight
        ctx.fillStyle = po.textColor
        ctx.fillText(`Frame: ${frameMs.toFixed(1)}ms  P95: ${perf.p95.toFixed(1)}ms`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Agents: ${agents.size}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Tool calls: ${toolCalls.size}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Particles: ${particles.length}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Edges: ${edges.length}`, textX, textY); textY += po.lineHeight
        ctx.fillText(`Discoveries: ${discoveries.length}`, textX, textY)
        ctx.restore()
      }

    } catch (err) {
      // Log at most once every 5s to avoid flooding the console
      const now = Date.now()
      if (now - lastDrawErrorRef.current > 5000) {
        lastDrawErrorRef.current = now
        console.warn('[AgentCanvas] draw error:', err)
      }
    }
  }, [detectStateChanges, updateCamera, updateDragLerp, transformRef])

  drawRef.current = draw

  useEffect(() => {
    const loop = (timestamp: number) => drawRef.current(timestamp)
    animationRef.current = requestAnimationFrame(loop)
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- drawRef is stable; rAF loop set up once
  }, [])

  // ─── Tooltip target (hover or keyboard focus) ──────────────────────────
  const focusedForTooltip = hasFocus ? focusedNode : null
  const tooltipTarget: NavNode | null = hoveredAgentId
    ? { type: 'agent', id: hoveredAgentId }
    : focusedForTooltip
  tooltipTargetRef.current = tooltipTarget
  const tooltipContent = tooltipTarget ? describeTooltip(tooltipTarget, simulationRef.current) : null

  // ─── Keyboard focus entry ──────────────────────────────────────────────
  const handleWrapperFocus = useCallback((e: React.FocusEvent) => {
    if (e.target !== e.currentTarget || focusedNodeRef.current) return
    // Only keyboard focus gets the automatic ring; a mouse click must not (matches :focus-visible)
    try { if (!e.currentTarget.matches(':focus-visible')) return } catch { /* older engines: fall through */ }
    // Show the ring immediately when keyboard focus lands on the graph
    const p = drawPropsRef.current
    const order = buildNodeOrder(p.agents, p.toolCalls, p.discoveries)
    const selected = p.selectedAgentId ? order.find(n => n.type === 'agent' && n.id === p.selectedAgentId) : undefined
    const first = selected ?? order[0] ?? null
    if (first) focusNode(first)
  }, [focusNode])

  const rootCursor = isDragging ? 'grabbing' : overInteractive ? 'pointer' : 'grab'
  const pausedBySystem = osReducedMotion

  return (
    <div
      ref={containerRef}
      data-agent-canvas-root=""
      className="relative w-full h-full overflow-hidden"
      style={{ cursor: rootCursor }}
      onFocus={() => setHasFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false)
      }}
    >
      {/* Graph surface: one image for assistive tech (its content is in the outline below),
          focusable so the keyboard map works (arrows, Enter, +/-/0, Shift+arrows, context menu key). */}
      <div
        role="img"
        aria-label={a11yModel.summary}
        aria-describedby="graph-keyboard-help"
        tabIndex={0}
        onFocus={handleWrapperFocus}
        onPointerDownCapture={(e) => { if (e.pointerType === 'mouse') setFocusedNode(null) }}
        {...keyHandlers}
        className="absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
      >
        <canvas
          ref={mainCanvasRef}
          style={{ width: dimensions.width, height: dimensions.height, touchAction: 'none' }}
          {...handlers}
          className="w-full h-full"
        />
      </div>
      <p id="graph-keyboard-help" className="sr-only">
        Arrow keys move between nodes. On an agent, Right opens a folded branch or enters its first sub-agent,
        Left folds an open branch or goes to the parent. Enter opens details. Plus and minus zoom, zero fits the graph.
        Shift with arrow keys pans. The context menu key or Shift F10 opens the context menu.
      </p>

      <GraphA11yList
        model={a11yModel}
        onLinkClick={onLinkClick}
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
        onToggleBranch={handleToggleBranch}
      />

      {/* Hover / focus tooltip (mirrors information available in the outline, so hidden from AT) */}
      <div
        ref={tooltipRef}
        aria-hidden="true"
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

      {/* Camera + comfort controls */}
      <div className="absolute right-3 bottom-20 z-10 flex max-w-[calc(100vw-24px)] flex-col items-end gap-1">
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomBy(CAMERA.keyboardZoomStep)}
            className={CONTROL_BUTTON_CLASS}
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            <span aria-hidden="true">+</span>
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / CAMERA.keyboardZoomStep)}
            className={CONTROL_BUTTON_CLASS}
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            <span aria-hidden="true">{'−'}</span>
          </button>
          <button
            type="button"
            aria-label="Fit graph to view"
            onClick={doZoomToFit}
            className={CONTROL_BUTTON_CLASS}
            style={{ background: COLORS.panelBg, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
          >
            Fit
          </button>
        </div>
        <button
          type="button"
          aria-pressed={animationsPaused || pausedBySystem}
          disabled={pausedBySystem}
          title={pausedBySystem ? 'Animations are reduced by your system settings' : undefined}
          onClick={toggleAnimationsPaused}
          className={CONTROL_BUTTON_CLASS}
          style={{
            background: animationsPaused || pausedBySystem ? COLORS.toggleActive : COLORS.panelBg,
            border: `1px solid ${COLORS.controlBorder}`,
            color: COLORS.textPrimary,
          }}
        >
          Pause animations
        </button>
        <button
          type="button"
          aria-pressed={neverHide}
          onClick={toggleNeverHide}
          className={CONTROL_BUTTON_CLASS}
          style={{
            background: neverHide ? COLORS.toggleActive : COLORS.panelBg,
            border: `1px solid ${COLORS.controlBorder}`,
            color: COLORS.textPrimary,
          }}
        >
          Keep cards visible
        </button>
      </div>

      <GraphLegend teams={a11yModel.teams} />
    </div>
  )
}

// ─── Tooltip helpers ──────────────────────────────────────────────────────

interface TooltipContent { title: string; lines: string[] }

/** Full name, state, model and task for an agent; name, state and args for a tool. */
function describeTooltip(node: NavNode, sim: SimulationState): TooltipContent | null {
  if (node.type === 'agent') {
    const a = sim.agents.get(node.id)
    if (!a) return null
    const lines = [
      `State: ${STATE_LABEL_LONG[a.state] ?? a.state}`,
      `Model: ${a.model ? formatModelName(a.model) : 'unknown'}`,
    ]
    if (a.kind === 'teammate') {
      lines.unshift(`Teammate${a.teamName ? ` of team ${cleanText(a.teamName)}` : ''}: ${teammateActivity(a) ?? agentStatusText(a)}`)
    }
    if (a.archived) lines.unshift('Archived: finished, kept so its conversation stays reachable')
    if (a.task) lines.push(`Task: ${a.task.length > 160 ? a.task.slice(0, 159) + '…' : a.task}`)
    return { title: a.name, lines }
  }
  if (node.type === 'tool') {
    const t = sim.toolCalls.get(node.id)
    if (!t) return null
    const lines = [`State: ${t.state}`]
    if (t.args) lines.push(t.args.length > 160 ? t.args.slice(0, 159) + '…' : t.args)
    return { title: t.toolName, lines }
  }
  const d = sim.discoveries.find(x => x.id === node.id)
  if (!d) return null
  return { title: d.label, lines: [`Discovery: ${d.type}`] }
}

/** Anchor the tooltip above its node in screen space; hide when the node is gone or off-canvas. */
function positionTooltip(
  el: HTMLDivElement | null,
  transform: { x: number; y: number; scale: number },
  canvasW: number,
  canvasH: number,
  scene: { agents: Map<string, Agent>; toolCalls: SimulationState['toolCalls']; discoveries: Discovery[] },
  target: NavNode | null,
) {
  if (!el) return
  let wx: number | null = null
  let wy: number | null = null
  let radius = 0
  if (target?.type === 'agent') {
    const a = scene.agents.get(target.id)
    if (a) { wx = a.x; wy = a.y; radius = agentDrawRadius(a) }
  } else if (target?.type === 'tool') {
    const t = scene.toolCalls.get(target.id)
    if (t) { wx = t.x; wy = t.y; radius = 16 }
  } else if (target?.type === 'discovery') {
    const d = scene.discoveries.find(x => x.id === target.id)
    if (d) { wx = d.x; wy = d.y; radius = 16 }
  }
  if (wx === null || wy === null) {
    if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden'
    return
  }
  const sx = wx * transform.scale + transform.x
  const sy = wy * transform.scale + transform.y - radius * transform.scale - 8
  const tw = el.offsetWidth
  const th = el.offsetHeight
  const x = Math.min(Math.max(sx - tw / 2, 4), Math.max(4, canvasW - tw - 4))
  // Flip below the node when there is no room above
  const y = sy - th < 4 ? sy + radius * transform.scale * 2 + 16 : sy - th
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.min(Math.max(y, 4), Math.max(4, canvasH - th - 4)))}px)`
  if (el.style.visibility !== 'visible') el.style.visibility = 'visible'
}
