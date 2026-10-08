import { useRef, useEffect, useState, type MutableRefObject, type RefObject } from 'react'
import type { TeamSummary } from '@/lib/agent-types'
import type { SessionLink } from '@/lib/session-links'
import type { SimulationState, AgentLink } from '@/hooks/simulation/types'
import { A11Y_SNAPSHOT_MS, expiryHold } from '@/lib/canvas-constants'
import {
  buildA11yModel, a11yRecorder, type A11yModel, type CommEntry, type SessionMeta,
} from '@/components/agent-visualizer/canvas/index'
import { sceneAgents, costScope } from '@/components/agent-visualizer/canvas/scene'
import type { NavNode } from '@/components/agent-visualizer/canvas/keyboard-nav'
import type { CollapseMemory, CollapseView } from '@/components/agent-visualizer/canvas/branch-collapse'
import { buildLinkMessageItems, type LinkMessageItem } from '@/components/agent-visualizer/canvas/edge-bubble-set'
import { attachBubbleLayer } from '@/components/agent-visualizer/canvas/edge-bubble-dom'
import type { CanvasDrawProps } from './use-canvas-draw-props'

const EMPTY_MODEL: A11yModel = { summary: 'Agent graph: no agents yet', agents: [], discoveries: [], teams: [], links: [], clusters: [] }

interface A11yMirrorDeps {
  simulationRef: RefObject<SimulationState>
  mainCanvasRef: RefObject<HTMLCanvasElement | null>
  drawPropsRef: MutableRefObject<CanvasDrawProps>
  hideInactiveRef: MutableRefObject<boolean>
  hasFocusRef: MutableRefObject<boolean>
  focusedNodeRef: MutableRefObject<NavNode | null>
  collapseMemoryRef: MutableRefObject<CollapseMemory>
  collapseViewRef: MutableRefObject<CollapseView>
  linksPropRef: MutableRefObject<Map<string, AgentLink> | undefined>
  teamsRef: MutableRefObject<Map<string, TeamSummary> | undefined>
  sessionsRef: MutableRefObject<ReadonlyMap<string, SessionMeta> | undefined>
  sessionLinksRef: MutableRefObject<ReadonlyArray<SessionLink> | undefined>
  onLinkClickRef: MutableRefObject<((linkId: string) => void) | undefined>
}

/**
 * Accessible mirror of the graph: a throttled snapshot of the simulation published to React state
 * (outline model, communications, link messages), and the DOM layer holding the focusable buttons of
 * the edge bubbles (click / Enter opens the link panel; hover and focus keep a bubble alive).
 */
export function useCanvasA11yMirror({
  simulationRef, mainCanvasRef, drawPropsRef, hideInactiveRef, hasFocusRef, focusedNodeRef,
  collapseMemoryRef, collapseViewRef, linksPropRef, teamsRef, sessionsRef, sessionLinksRef, onLinkClickRef,
}: A11yMirrorDeps) {
  const [a11yModel, setA11yModel] = useState<A11yModel>(EMPTY_MODEL)
  const [communications, setCommunications] = useState<CommEntry[]>([])
  const [linkMessages, setLinkMessages] = useState<LinkMessageItem[]>([])
  const a11ySignatureRef = useRef('')
  const linkMessagesSigRef = useRef('')
  /** DOM layer holding the focusable buttons of the edge bubbles, and the message ids hovered / focused in it */
  const bubbleLayerRef = useRef<HTMLDivElement>(null)
  const heldBubbleKeysRef = useRef<ReadonlySet<string>>(new Set())

  // ─── Edge bubble buttons ───
  useEffect(() => {
    const layer = bubbleLayerRef.current
    if (!layer) return
    const dispose = attachBubbleLayer(layer, {
      onOpen: linkId => onLinkClickRef.current?.(linkId),
      onHoldChange: (_ids, keys) => { heldBubbleKeysRef.current = keys },
      forwardTarget: () => mainCanvasRef.current,
    })
    return () => { dispose(); heldBubbleKeysRef.current = new Set() }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable; the layer is attached once
  }, [])

  // ─── Throttled snapshot of the simulation ───
  useEffect(() => {
    const snapshot = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      const s = simulationRef.current
      // Tool calls and communications are recorded per frame by the simulation step (a11yRecorder);
      // this timer only publishes them to React state.
      const dp = drawPropsRef.current
      const scene = sceneAgents(s.agents, hideInactiveRef.current, [dp.selectedAgentId],
        { agentId: dp.selectedAgentId, toolCallId: dp.selectedToolCallId ?? null, discoveryId: dp.selectedDiscoveryId ?? null },
        hasFocusRef.current ? focusedNodeRef.current : null, collapseMemoryRef.current, s)
      collapseViewRef.current = scene.collapse
      const model = buildA11yModel(scene.agents, scene.toolCalls, scene.discoveries, a11yRecorder.tools, {
        links: linksPropRef.current ?? s.links, edges: s.edges, collapse: scene.collapse, teams: teamsRef.current, simTime: s.currentTime,
        sessions: sessionsRef.current, sessionLinks: sessionLinksRef.current, costAgents: costScope(s).agents.values(),
      })
      const comms = Array.from(a11yRecorder.comms.values())
      const signature = JSON.stringify([model, comms.length, comms[comms.length - 1]?.id])
      if (signature === a11ySignatureRef.current) return
      a11ySignatureRef.current = signature
      setA11yModel(model)
      setCommunications(comms)
      const items = buildLinkMessageItems(linksPropRef.current ?? s.links, s.agents)
      const itemsSig = items.map(i => `${i.id}:${i.text}`).join('\n')
      if (itemsSig !== linkMessagesSigRef.current) {
        linkMessagesSigRef.current = itemsSig
        setLinkMessages(items)
      }
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
  }, [simulationRef]) // eslint-disable-line react-hooks/exhaustive-deps -- the other deps are refs

  return { a11yModel, communications, linkMessages, bubbleLayerRef, heldBubbleKeysRef }
}
