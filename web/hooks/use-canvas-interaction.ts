import { useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, Discovery, ANIM } from '@/lib/agent-types'
import { CAMERA } from '@/lib/canvas-constants'
import { hitTestAt, type HitTarget, type ResolvedLink } from '@/components/agent-visualizer/canvas/index'
import {
  keyToAction, stepFocus, buildNodeOrder, locateNode, sameNode, type NavNode,
} from '@/components/agent-visualizer/canvas/keyboard-nav'
import { treeKeyAction, type CollapseView } from '@/components/agent-visualizer/canvas/branch-collapse'
import type { Transform } from './use-canvas-camera'

interface InteractionCallbacks {
  /** `modifiers.shiftKey` lets the app implement click + Shift-click (pair filter) */
  onAgentClick: (agentId: string | null, modifiers?: { shiftKey: boolean }) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  onDiscoveryClick?: (discoveryId: string | null) => void
  /** A communication link was clicked (canvas edge or its count badge) */
  onLinkClick?: (linkId: string) => void
  /** A cluster label (session / team halo) was clicked */
  onClusterClick?: (clusterKey: string) => void
  /** The badge of a collapsed branch was clicked, or Left / Right asked to fold / unfold it */
  onToggleBranch?: (agentId: string) => void
}

interface InteractionOptions {
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    discoveries: Discovery[]
    /** Resolved communication links, hit-tested last (they are drawn under the nodes) */
    links?: ResolvedLink[]
    /** Collapse state of the branches (badges are hit-tested and Left / Right drive it) */
    collapse?: CollapseView
  } & InteractionCallbacks>
  transformRef: MutableRefObject<Transform>
  userHasNavigatedRef: MutableRefObject<boolean>
  panVelocityRef: MutableRefObject<{ vx: number; vy: number; active: boolean }>
  simTimeRef: MutableRefObject<number>
  screenToCanvas: (screenX: number, screenY: number) => { x: number; y: number }
  doZoomToFit: () => void
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  /** Camera controls shared by keyboard, buttons and pinch */
  zoomBy: (factor: number, originX?: number, originY?: number) => void
  panBy: (dx: number, dy: number) => void
  canvasToScreen: (worldX: number, worldY: number) => { x: number; y: number }
  ensureVisible: (worldX: number, worldY: number) => void
  /** Keyboard focus ring state (owned by AgentCanvas so the draw loop and DOM mirror can read it) */
  focusedNodeRef: MutableRefObject<NavNode | null>
  onFocusedNodeChange: (node: NavNode | null) => void
  /** Optional: told which element is under the pointer (used to hold expiring cards while hovered) */
  onHoverTargetChange?: (target: HitTarget | null) => void
}

export function useCanvasInteraction({
  drawPropsRef,
  transformRef,
  userHasNavigatedRef,
  panVelocityRef,
  simTimeRef,
  screenToCanvas,
  doZoomToFit,
  mainCanvasRef,
  zoomBy,
  panBy,
  canvasToScreen,
  ensureVisible,
  focusedNodeRef,
  onFocusedNodeChange,
  onHoverTargetChange,
}: InteractionOptions) {
  const [isDragging, setIsDragging] = useState(false)
  /** True while the pointer is over something clickable (drives the `pointer` cursor) */
  const [overInteractive, setOverInteractive] = useState(false)
  const isDraggingRef = useRef(false)
  const dragTargetRef = useRef<{ type: 'canvas' | 'agent'; id?: string; startX: number; startY: number } | null>(null)
  isDraggingRef.current = isDragging

  // Floaty agent drag
  const dragLerpRef = useRef<{ targetX: number; targetY: number; agentId: string } | null>(null)

  // Pan tracking
  const lastPanPosRef = useRef({ x: 0, y: 0, time: 0 })
  const lastHoveredIdRef = useRef<string | null>(null)
  const lastHoverKeyRef = useRef<string | null>(null)

  // Active pointers (mouse, pen, touch) for pinch-to-zoom
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ dist: number } | null>(null)
  /** True from the start of a pinch until every pointer is up: the remaining finger must not click */
  const gestureConsumedRef = useRef(false)

  // ─── Hit detection ──────────────────────────────────────────────────────

  const hitTest = useCallback((clientX: number, clientY: number): HitTarget | null => {
    const pos = screenToCanvas(clientX, clientY)
    const p = drawPropsRef.current
    return hitTestAt(pos.x, pos.y, p, simTimeRef.current, transformRef.current.scale)
  }, [screenToCanvas, drawPropsRef, simTimeRef, transformRef])

  const updateHover = useCallback((target: HitTarget | null) => {
    const agentId = target?.type === 'agent' ? target.id : null
    if (agentId !== lastHoveredIdRef.current) {
      lastHoveredIdRef.current = agentId
      drawPropsRef.current.onAgentHover(agentId)
    }
    const key = target ? `${target.type}:${target.id}` : null
    if (key !== lastHoverKeyRef.current) {
      lastHoverKeyRef.current = key
      setOverInteractive(target !== null)
      onHoverTargetChange?.(target)
    }
  }, [drawPropsRef, onHoverTargetChange])

  // ─── Pointer Handlers (mouse, pen, touch) ───────────────────────────────

  const endDrag = useCallback(() => {
    setIsDragging(false)
    dragTargetRef.current = null
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Right button is handled by the contextmenu event; ignore other auxiliary buttons
    if (e.pointerType === 'mouse' && e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointersRef.current.size === 2) {
      // Second finger: switch from drag to pinch
      const [a, b] = Array.from(pointersRef.current.values())
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) }
      gestureConsumedRef.current = true
      dragTargetRef.current = null
      dragLerpRef.current = null
      setIsDragging(false)
      return
    }

    const hit = hitTest(e.clientX, e.clientY)
    panVelocityRef.current = { vx: 0, vy: 0, active: false }
    setIsDragging(true)
    if (hit?.type === 'agent') {
      dragTargetRef.current = { type: 'agent', id: hit.id, startX: e.clientX, startY: e.clientY }
    } else {
      dragTargetRef.current = { type: 'canvas', startX: e.clientX, startY: e.clientY }
      lastPanPosRef.current = { x: e.clientX, y: e.clientY, time: performance.now() }
    }
  }, [hitTest, panVelocityRef])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }

    // Pinch-to-zoom around the midpoint of the two pointers
    if (pinchRef.current && pointersRef.current.size >= 2) {
      const [a, b] = Array.from(pointersRef.current.values())
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const prev = pinchRef.current.dist
      if (prev > 0 && dist > 0) {
        const rect = mainCanvasRef.current?.getBoundingClientRect()
        zoomBy(dist / prev, (a.x + b.x) / 2 - (rect?.left ?? 0), (a.y + b.y) / 2 - (rect?.top ?? 0))
      }
      pinchRef.current = { dist }
      return
    }

    // Hover feedback only makes sense for mouse / pen
    if (e.pointerType !== 'touch') updateHover(hitTest(e.clientX, e.clientY))

    const dragging = isDraggingRef.current
    const dragTarget = dragTargetRef.current
    if (dragging && dragTarget) {
      if (dragTarget.type === 'canvas') {
        userHasNavigatedRef.current = true
        const dx = e.clientX - dragTarget.startX
        const dy = e.clientY - dragTarget.startY
        const t = transformRef.current
        transformRef.current = { ...t, x: t.x + dx, y: t.y + dy }
        const now = performance.now()
        const elapsed = Math.max(now - lastPanPosRef.current.time, 1) / 1000
        panVelocityRef.current = {
          vx: (e.clientX - lastPanPosRef.current.x) / elapsed * CAMERA.velocityScale,
          vy: (e.clientY - lastPanPosRef.current.y) / elapsed * CAMERA.velocityScale,
          active: false,
        }
        lastPanPosRef.current = { x: e.clientX, y: e.clientY, time: now }
        dragTargetRef.current = { ...dragTarget, startX: e.clientX, startY: e.clientY }
      } else if (dragTarget.type === 'agent' && dragTarget.id) {
        const screenDist = Math.abs(e.clientX - dragTarget.startX) + Math.abs(e.clientY - dragTarget.startY)
        if (screenDist > ANIM.dragThresholdPx) {
          const pos = screenToCanvas(e.clientX, e.clientY)
          dragLerpRef.current = { targetX: pos.x, targetY: pos.y, agentId: dragTarget.id }
        }
      }
    }
  }, [screenToCanvas, hitTest, updateHover, mainCanvasRef, zoomBy, userHasNavigatedRef, transformRef, panVelocityRef])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const wasPinching = pinchRef.current !== null || gestureConsumedRef.current
    pointersRef.current.delete(e.pointerId)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    if (pointersRef.current.size === 0) gestureConsumedRef.current = false
    if (wasPinching) {
      // Finish the pinch gesture when fewer than two pointers remain; never treat it as a click
      if (pointersRef.current.size < 2) pinchRef.current = null
      endDrag()
      return
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return

    const dt_ = dragTargetRef.current
    if (dt_?.type === 'canvas') {
      const v = panVelocityRef.current
      if (Math.abs(v.vx) > ANIM.inertiaThreshold || Math.abs(v.vy) > ANIM.inertiaThreshold) {
        panVelocityRef.current.active = true
      }
    }
    const screenDist = dt_
      ? Math.abs(e.clientX - dt_.startX) + Math.abs(e.clientY - dt_.startY)
      : 0
    if (screenDist < ANIM.dragThresholdPx) {
      const hit = hitTest(e.clientX, e.clientY)
      const p = drawPropsRef.current
      if (hit?.type === 'agent' || hit?.type === 'bubble') {
        p.onAgentClick(hit.id, { shiftKey: e.shiftKey })
      } else if (hit?.type === 'tool') {
        p.onToolCallClick?.(hit.id)
      } else if (hit?.type === 'discovery') {
        p.onDiscoveryClick?.(hit.id)
      } else if (hit?.type === 'link') {
        p.onLinkClick?.(hit.id)
      } else if (hit?.type === 'cluster') {
        p.onClusterClick?.(hit.id)
      } else if (hit?.type === 'branch') {
        p.onToggleBranch?.(hit.id)
      } else {
        p.onAgentClick(null)
        p.onToolCallClick?.(null)
        p.onDiscoveryClick?.(null)
      }
    }
    if (dragLerpRef.current) {
      drawPropsRef.current.onAgentDrag(dragLerpRef.current.agentId, dragLerpRef.current.targetX, dragLerpRef.current.targetY)
      dragLerpRef.current = null
    }
    endDrag()
  }, [hitTest, drawPropsRef, panVelocityRef, endDrag])

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (pointersRef.current.size === 0) gestureConsumedRef.current = false
    dragLerpRef.current = null
    endDrag()
  }, [endDrag])

  const handlePointerLeave = useCallback((e: React.PointerEvent) => {
    // While a pointer is captured, leave events do not fire; this only runs for plain hover exits
    if (e.pointerType === 'touch') return
    updateHover(null)
  }, [updateHover])

  // Wheel handler attached as native event (passive: false) to allow preventDefault
  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault()
    userHasNavigatedRef.current = true
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY > 0 ? CAMERA.zoomStepDown : CAMERA.zoomStepUp
      const rect = mainCanvasRef.current?.getBoundingClientRect()
      if (!rect) return
      zoomBy(delta, e.clientX - rect.left, e.clientY - rect.top)
    } else {
      const prev = transformRef.current
      transformRef.current = { ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }
    }
  }
  useEffect(() => {
    const canvas = mainCanvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => handleWheelRef.current(e)
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [mainCanvasRef])

  const handleDoubleClick = useCallback(() => {
    doZoomToFit()
  }, [doZoomToFit])

  const handleContextMenuEvent = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const hit = hitTest(e.clientX, e.clientY)
    const agentId = hit?.type === 'agent' || hit?.type === 'bubble' ? hit.id : null
    drawPropsRef.current.onContextMenu(e, agentId ? 'agent' : 'canvas', agentId ?? undefined)
  }, [hitTest, drawPropsRef])

  /** Call from draw loop to update floaty drag lerp */
  const updateDragLerp = useCallback((agents: Map<string, Agent>, onAgentDrag: (id: string, x: number, y: number) => void) => {
    const lerp = dragLerpRef.current
    if (lerp) {
      const agent = agents.get(lerp.agentId)
      if (agent) {
        const lerpFactor = ANIM.dragLerp
        const nx = agent.x + (lerp.targetX - agent.x) * lerpFactor
        const ny = agent.y + (lerp.targetY - agent.y) * lerpFactor
        onAgentDrag(lerp.agentId, nx, ny)
      }
    }
  }, [])

  // ─── Keyboard ───────────────────────────────────────────────────────────

  /** Move the focus ring to `node` and keep it on screen. */
  const focusNode = useCallback((node: NavNode | null) => {
    onFocusedNodeChange(node)
    if (!node) return
    const pos = locateNode(node, drawPropsRef.current)
    if (pos) ensureVisible(pos.x, pos.y)
  }, [onFocusedNodeChange, drawPropsRef, ensureVisible])

  const activateNode = useCallback((node: NavNode) => {
    const p = drawPropsRef.current
    if (node.type === 'agent') p.onAgentClick(node.id)
    else if (node.type === 'tool') p.onToolCallClick?.(node.id)
    else p.onDiscoveryClick?.(node.id)
  }, [drawPropsRef])

  const openContextMenuAt = useCallback((node: NavNode | null) => {
    const p = drawPropsRef.current
    const rect = mainCanvasRef.current?.getBoundingClientRect()
    const pos = node ? locateNode(node, p) : null
    // Anchor at the node (never at 0,0: the selection state treats that as "no position"),
    // or at the viewport centre when nothing is focused.
    const screen = pos
      ? canvasToScreen(pos.x, pos.y)
      : { x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2 }
    const synthetic = {
      clientX: Math.max(1, Math.round(screen.x)),
      clientY: Math.max(1, Math.round(screen.y)),
      preventDefault() {},
      stopPropagation() {},
    } as unknown as React.MouseEvent
    p.onContextMenu(synthetic, node?.type === 'agent' ? 'agent' : 'canvas', node?.type === 'agent' ? node.id : undefined)
  }, [drawPropsRef, mainCanvasRef, canvasToScreen])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Only react to keys pressed on the graph itself, not on controls nested inside it
    if (e.target !== e.currentTarget) return
    const current = focusedNodeRef.current
    // Tree-style Left / Right on an agent (fold, unfold, parent, first child); other cases use the graph map below
    if (current?.type === 'agent' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const p = drawPropsRef.current
      const tree = p.collapse ? treeKeyAction(e.key, current.id, p.agents, p.collapse) : null
      if (tree) {
        if (tree.kind === 'toggle') p.onToggleBranch?.(tree.id)
        else focusNode({ type: 'agent', id: tree.id })
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
    const action = keyToAction(e)
    if (!action) return
    switch (action.kind) {
      case 'step': {
        const p = drawPropsRef.current
        const next = stepFocus(buildNodeOrder(p.agents, p.toolCalls, p.discoveries), current, action.dir)
        if (!sameNode(next, current)) focusNode(next)
        break
      }
      case 'pan':
        panBy(action.dx, action.dy)
        break
      case 'zoom': {
        // Zoom centred on the focused node when there is one, else on the viewport
        const pos = current ? locateNode(current, drawPropsRef.current) : null
        if (pos) {
          const t = transformRef.current
          zoomBy(action.factor, pos.x * t.scale + t.x, pos.y * t.scale + t.y)
        } else {
          zoomBy(action.factor)
        }
        break
      }
      case 'fit':
        doZoomToFit()
        break
      case 'activate':
        if (current) activateNode(current)
        break
      case 'contextmenu':
        openContextMenuAt(current)
        break
    }
    e.preventDefault()
    e.stopPropagation()
  }, [focusedNodeRef, drawPropsRef, focusNode, panBy, zoomBy, transformRef, doZoomToFit, activateNode, openContextMenuAt])

  return {
    isDragging,
    overInteractive,
    dragLerpRef,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onPointerLeave: handlePointerLeave,
      onDoubleClick: handleDoubleClick,
      onContextMenu: handleContextMenuEvent,
    },
    keyHandlers: { onKeyDown: handleKeyDown },
    focusNode,
    activateNode,
    updateDragLerp,
  }
}
