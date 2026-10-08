import { useRef, useCallback } from 'react'
import type { ResolvedLink } from '@/components/agent-visualizer/canvas/index'
import type { NavNode } from '@/components/agent-visualizer/canvas/keyboard-nav'
import type { CanvasProps } from '@/components/agent-visualizer/canvas/canvas-props'
import { sceneAgents } from '@/components/agent-visualizer/canvas/scene'
import {
  createCollapseMemory, toggleBranch, type CollapseMemory, type CollapseView,
} from '@/components/agent-visualizer/canvas/branch-collapse'

const EMPTY_COLLAPSE: CollapseView = { branches: new Map(), hidden: new Set() }

interface SceneInputs {
  hasFocus: boolean
  focusedNode: NavNode | null
  dimensions: { width: number; height: number }
  onClusterClick: (key: string) => void
}

function buildDrawProps(
  props: CanvasProps,
  { hasFocus, focusedNode, dimensions, onClusterClick }: SceneInputs,
  collapseMemory: CollapseMemory,
  onToggleBranch: (id: string) => void,
  prev?: { isDragging: boolean; links: ResolvedLink[] },
) {
  const {
    simulationRef, selectedAgentId, hoveredAgentId, showStats, showHexGrid, pauseAutoFit,
    onAgentClick, onAgentHover, onAgentDrag, onContextMenu, onToolCallClick, selectedToolCallId, onDiscoveryClick,
    selectedDiscoveryId, showCostOverlay, hideInactive = false, onLinkClick, selectedLinkId,
  } = props
  const sim = simulationRef.current
  const scene = sceneAgents(sim.agents, hideInactive, [selectedAgentId, hoveredAgentId],
    { agentId: selectedAgentId, toolCallId: selectedToolCallId ?? null, discoveryId: selectedDiscoveryId ?? null },
    hasFocus ? focusedNode : null, collapseMemory, sim)
  return {
    scene,
    drawProps: {
      agents: scene.agents, collapse: scene.collapse, onToggleBranch, toolCalls: scene.toolCalls,
      particles: sim.particles, edges: sim.edges, discoveries: scene.discoveries,
      selectedAgentId, hoveredAgentId, showStats, showHexGrid,
      showCostOverlay, selectedToolCallId, selectedDiscoveryId, selectedLinkId,
      simTime: sim.currentTime, pauseAutoFit, dimensions,
      // Resolved by the draw loop each frame; carried over so a pointer event between a render and the
      // next frame still hit-tests against the links of the previous frame (never an empty list)
      links: prev?.links ?? ([] as ResolvedLink[]),
      onAgentDrag, onAgentClick, onAgentHover, onContextMenu,
      onToolCallClick, onDiscoveryClick, onLinkClick,
      onClusterClick,
      isDragging: prev?.isDragging ?? false,
    },
  }
}

export type CanvasDrawProps = ReturnType<typeof buildDrawProps>['drawProps']

/**
 * The scene the canvas draws and hit-tests (visible agents, tool calls, discoveries, collapsed
 * branches) and the props the draw loop and the pointer handlers read through `drawPropsRef`.
 * The loop refreshes the scene each frame; this rebuilds it on every render so a pointer event
 * between a render and the next frame sees the new props.
 */
export function useCanvasDrawProps(props: CanvasProps, inputs: Omit<SceneInputs, 'onClusterClick'>) {
  const hideInactiveRef = useRef(props.hideInactive ?? false)
  hideInactiveRef.current = props.hideInactive ?? false
  // Collapse of inactive sub-trees: the user's choices live here for the life of the canvas
  const collapseMemoryRef = useRef<CollapseMemory>(createCollapseMemory())
  const collapseViewRef = useRef<CollapseView>(EMPTY_COLLAPSE)
  const handleToggleBranch = useCallback((id: string) => {
    toggleBranch(collapseMemoryRef.current, collapseViewRef.current, id)
  }, [])
  const handleClusterClickRef = useRef<(key: string) => void>(() => {})

  const make = (prev?: CanvasDrawProps) => {
    const built = buildDrawProps(
      props,
      { ...inputs, onClusterClick: (key: string) => handleClusterClickRef.current(key) },
      collapseMemoryRef.current, handleToggleBranch,
      prev,
    )
    collapseViewRef.current = built.scene.collapse
    return built.drawProps
  }
  const drawPropsRef = useRef(make())
  drawPropsRef.current = make(drawPropsRef.current)

  return { drawPropsRef, hideInactiveRef, collapseMemoryRef, collapseViewRef, handleToggleBranch, handleClusterClickRef }
}
