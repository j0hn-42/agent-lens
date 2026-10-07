import { useRef, useEffect, useCallback, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, Discovery, ANIM } from '@/lib/agent-types'
import {
  computeFitBounds, fitToView, fitInsets, circleBounds, clusterSetSignature, shouldResumeAutoFit,
  type Transform, type Insets, type AutoFitState,
} from '@/components/agent-visualizer/canvas/camera-fit'
import type { Cluster } from '@/components/agent-visualizer/canvas/cluster-model'
import { CAMERA } from '@/lib/canvas-constants'

export type { Transform }

interface CameraOptions {
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    discoveries: Discovery[]
    dimensions: { width: number; height: number }
    selectedAgentId: string | null
    pauseAutoFit?: boolean
    isDragging: boolean
  }>
  simTimeRef: MutableRefObject<number>
  dimensions: { width: number; height: number }
  agentCount: number
  zoomToFitTrigger?: number
  selectedAgentId: string | null
  /** Clusters of the last drawn frame (halos are part of the fit bounds) */
  clustersRef?: MutableRefObject<Cluster[]>
  /** Insets of the UI overlaid on the canvas (top bar, control bar, panels), in canvas px */
  getInsets?: () => Insets
}

export function useCanvasCamera({
  mainCanvasRef,
  drawPropsRef,
  simTimeRef,
  dimensions,
  agentCount,
  zoomToFitTrigger,
  selectedAgentId,
  clustersRef,
  getInsets,
}: CameraOptions) {
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 })
  const userHasNavigatedRef = useRef(false)
  const targetTransformRef = useRef<Transform | null>(null)
  const panVelocityRef = useRef({ vx: 0, vy: 0, active: false })
  const autoFitStateRef = useRef<AutoFitState>({ signature: null, width: 0, height: 0 })

  // Initialize transform centered on first agents
  useEffect(() => {
    if (agentCount > 0 && transformRef.current.x === 0 && transformRef.current.y === 0) {
      transformRef.current = { x: dimensions.width / 2, y: dimensions.height / 2, scale: 1 }
    }
  }, [agentCount, dimensions])

  // Collect an agent and all its descendants (BFS)
  const getDescendantIds = useCallback((agents: Map<string, Agent>, rootId: string): Set<string> => {
    const ids = new Set<string>([rootId])
    const queue = [rootId]
    while (queue.length > 0) {
      const parentId = queue.shift()!
      for (const [id, agent] of agents) {
        if (agent.parentId === parentId && !ids.has(id)) {
          ids.add(id)
          queue.push(id)
        }
      }
    }
    return ids
  }, [])

  const computeFitTransform = useCallback((): Transform | null => {
    const { agents, toolCalls, discoveries, dimensions, selectedAgentId } = drawPropsRef.current
    if (agents.size === 0) return null

    // Determine focus scope: if a non-main agent is selected, focus on it + descendants
    let focusScope: Set<string> | null = null
    if (selectedAgentId) {
      const selected = agents.get(selectedAgentId)
      if (selected && !selected.isMain) {
        focusScope = getDescendantIds(agents, selectedAgentId)
      }
    }

    // No result cache: the simulation mutates its Maps in place, so a reference-keyed cache would keep
    // the bounds of the first (unsettled) layout forever.
    const clusters = clustersRef?.current ?? []
    const bounds = computeFitBounds({
      agents: agents.values(), toolCalls: toolCalls.values(), discoveries, clusters, focusScope,
      simTime: simTimeRef.current ?? 0,
    })
    const insets = fitInsets(getInsets?.(), !focusScope && clusters.length > 0)
    return fitToView(bounds, dimensions, insets)
  }, [getDescendantIds, drawPropsRef, simTimeRef, clustersRef, getInsets])

  const doZoomToFit = useCallback(() => {
    userHasNavigatedRef.current = false
    const target = computeFitTransform()
    if (target) targetTransformRef.current = target
  }, [computeFitTransform])

  useEffect(() => {
    if (zoomToFitTrigger && zoomToFitTrigger > 0) doZoomToFit()
  }, [zoomToFitTrigger, doZoomToFit])

  // Selection changes cancel any in-flight camera lerp, but never re-enable auto-fit:
  // once the user panned/zoomed manually the camera stays where they put it
  // (an explicit "Fit" or the fit trigger re-enables it).
  useEffect(() => {
    targetTransformRef.current = null
  }, [selectedAgentId])

  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    const canvas = mainCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (screenX - rect.left - t.x) / t.scale,
      y: (screenY - rect.top - t.y) / t.scale,
    }
  }, [mainCanvasRef])

  /** Zoom by `factor` around a point given in canvas-local screen px (defaults to the viewport centre). */
  const zoomBy = useCallback((factor: number, originX?: number, originY?: number) => {
    userHasNavigatedRef.current = true
    targetTransformRef.current = null
    panVelocityRef.current = { vx: 0, vy: 0, active: false }
    const { width, height } = drawPropsRef.current.dimensions
    const ox = originX ?? width / 2
    const oy = originY ?? height / 2
    const prev = transformRef.current
    const newScale = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, prev.scale * factor))
    const ratio = newScale / prev.scale
    transformRef.current = { scale: newScale, x: ox - (ox - prev.x) * ratio, y: oy - (oy - prev.y) * ratio }
  }, [drawPropsRef])

  /** Pan by a screen-pixel delta. */
  const panBy = useCallback((dx: number, dy: number) => {
    userHasNavigatedRef.current = true
    targetTransformRef.current = null
    panVelocityRef.current = { vx: 0, vy: 0, active: false }
    const t = transformRef.current
    transformRef.current = { ...t, x: t.x + dx, y: t.y + dy }
  }, [])

  /** Convert a world point to client (viewport) coordinates, e.g. to anchor a context menu. */
  const canvasToScreen = useCallback((worldX: number, worldY: number) => {
    const canvas = mainCanvasRef.current
    const rect = canvas?.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (rect?.left ?? 0) + worldX * t.scale + t.x,
      y: (rect?.top ?? 0) + worldY * t.scale + t.y,
    }
  }, [mainCanvasRef])

  /**
   * Pan (without changing zoom) just enough to bring a world point inside the viewport,
   * keeping `margin` px from the edges. Used when keyboard focus moves to an off-screen node.
   */
  const ensureVisible = useCallback((worldX: number, worldY: number, margin = 80) => {
    const { width, height } = drawPropsRef.current.dimensions
    const t = transformRef.current
    const sx = worldX * t.scale + t.x
    const sy = worldY * t.scale + t.y
    let dx = 0, dy = 0
    if (sx < margin) dx = margin - sx
    else if (sx > width - margin) dx = width - margin - sx
    if (sy < margin) dy = margin - sy
    else if (sy > height - margin) dy = height - margin - sy
    if (dx !== 0 || dy !== 0) {
      userHasNavigatedRef.current = true
      targetTransformRef.current = { ...t, x: t.x + dx, y: t.y + dy }
    }
  }, [drawPropsRef])

  /** Smoothly frame a world circle (a cluster halo) in the viewport. Counts as a manual navigation. */
  const zoomToCircle = useCallback((cx: number, cy: number, r: number) => {
    const { width, height } = drawPropsRef.current.dimensions
    if (!(r > 0) || width <= 0 || height <= 0) return
    userHasNavigatedRef.current = true
    panVelocityRef.current = { vx: 0, vy: 0, active: false }
    const target = fitToView(circleBounds(cx, cy, r), { width, height }, fitInsets(getInsets?.(), true))
    if (target) targetTransformRef.current = target
  }, [drawPropsRef, getInsets])

  /** Call from draw loop to update inertia and auto-fit lerp */
  const updateCamera = useCallback((isDragging: boolean, pauseAutoFit?: boolean) => {
    const transform = transformRef.current

    // Pan inertia
    const inertia = panVelocityRef.current
    if (inertia.active) {
      transformRef.current = { ...transform, x: transform.x + inertia.vx, y: transform.y + inertia.vy }
      inertia.vx *= ANIM.inertiaDecay
      inertia.vy *= ANIM.inertiaDecay
      if (Math.abs(inertia.vx) < 0.1 && Math.abs(inertia.vy) < 0.1) {
        inertia.active = false
      }
    }

    // Resume following the content when the clusters / sessions changed (tab or cluster selection) or the
    // canvas was resized; a manual pan / zoom is otherwise respected.
    {
      const { agents, dimensions } = drawPropsRef.current
      let signature: string | null = null
      if (agents.size > 0) {
        const sessions: Array<string | undefined> = []
        for (const a of agents.values()) sessions.push(a.sessionId)
        signature = clusterSetSignature((clustersRef?.current ?? []).map(c => c.key), sessions)
      }
      const next: AutoFitState = { signature, width: dimensions.width, height: dimensions.height }
      const prev = autoFitStateRef.current
      if (shouldResumeAutoFit(prev, next)) {
        userHasNavigatedRef.current = false
        targetTransformRef.current = null
      }
      autoFitStateRef.current = next
    }

    // Auto-fit
    if (!userHasNavigatedRef.current && !isDragging && !pauseAutoFit) {
      const fit = computeFitTransform()
      if (fit) targetTransformRef.current = fit
    }

    // Smooth lerp toward target
    const target = targetTransformRef.current
    if (target) {
      const lerpSpeed = ANIM.autoFitLerp
      const t = transformRef.current
      const nx = t.x + (target.x - t.x) * lerpSpeed
      const ny = t.y + (target.y - t.y) * lerpSpeed
      const ns = t.scale + (target.scale - t.scale) * lerpSpeed
      if (Math.abs(target.x - nx) < 0.5 && Math.abs(target.y - ny) < 0.5 && Math.abs(target.scale - ns) < 0.001) {
        targetTransformRef.current = null
        transformRef.current = { x: target.x, y: target.y, scale: target.scale }
      } else {
        transformRef.current = { x: nx, y: ny, scale: ns }
      }
    }
  }, [computeFitTransform, drawPropsRef, clustersRef])

  return {
    transformRef,
    userHasNavigatedRef,
    panVelocityRef,
    screenToCanvas,
    doZoomToFit,
    updateCamera,
    zoomBy,
    panBy,
    canvasToScreen,
    ensureVisible,
    zoomToCircle,
  }
}
