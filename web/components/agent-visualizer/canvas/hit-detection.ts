/**
 * Hit-testing in canvas-world coordinates, sized in SCREEN pixels.
 * Every function takes the camera `scale` so that targets never shrink below a
 * usable size when zoomed out (WCAG 2.5.8), ignores nearly invisible elements,
 * and walks the Map in reverse so the element drawn on top wins.
 * Runtime imports are relative so the pure parts can be unit-tested with node:test.
 */
import type { Agent, ToolCallNode, Discovery } from '../../../lib/agent-types'
import { toolCardExpanded } from '../../../lib/tool-lifecycle'
import {
  BUBBLE_MAX_W, BUBBLE_GAP, TOOL_MAX_CARD_W, getDiscoveryCardDimensions,
  AGENT_DRAW, HIT_DETECTION, BUBBLE_DRAW, TOOL_DRAW, MIN_VISIBLE_OPACITY, isExpiryHeld,
} from '../../../lib/canvas-constants'
import { bubbleAlpha } from './bubble-utils'
import { getToolCardSize } from './render-cache'
import type { FocusShape } from './draw-misc'
import { isAgentVisible, agentDrawOpacity, agentDrawRadius } from './team-style'
import { overlayHits } from './overlay-state'
import { lodForZoom } from './draw-options'
import { findLinkAt, type ResolvedLink } from './link-geometry'
import type { NavNode } from './keyboard-nav'

/** Radius (world units) of an agent hit area: at least `minPx` screen pixels. */
export function hitRadiusWorld(baseWorldRadius: number, scale: number, minPx: number): number {
  const safeScale = scale > 0 ? scale : 1
  return Math.max(baseWorldRadius, minPx / safeScale)
}

/** Is (x, y) inside the rect, after growing the rect to at least `minPx` screen pixels on each axis? */
export function pointInMinRect(
  x: number, y: number,
  left: number, top: number, w: number, h: number,
  scale: number, minPx: number,
): boolean {
  const safeScale = scale > 0 ? scale : 1
  const minWorld = minPx / safeScale
  const padX = Math.max(0, (minWorld - w) / 2)
  const padY = Math.max(0, (minWorld - h) / 2)
  return x >= left - padX && x <= left + w + padX && y >= top - padY && y <= top + h + padY
}

function* reverseValues<T>(items: Iterable<T>): Generator<T> {
  const list = Array.isArray(items) ? items : Array.from(items)
  for (let i = list.length - 1; i >= 0; i--) yield list[i]
}

/**
 * Find which agent (if any) is at the given canvas-space coordinates.
 * Returns the agent id, or null.
 */
export function findAgentAt(
  x: number,
  y: number,
  agents: Map<string, Agent>,
  scale = 1,
): string | null {
  for (const [id, agent] of reverseEntries(agents)) {
    // Archived agents and teammates stay clickable even when their opacity is low
    if (!isAgentVisible(agent)) continue
    const base = agentDrawRadius(agent)
    const r = hitRadiusWorld(base, scale, HIT_DETECTION.minAgentRadiusPx)
    const dx = x - agent.x
    const dy = y - agent.y
    if (dx * dx + dy * dy <= r * r) return id
  }
  return null
}

function reverseEntries<K, V>(map: Map<K, V>): Array<[K, V]> {
  return Array.from(map.entries()).reverse()
}

/** Size of a tool card: the drawn size when known, an estimate otherwise. */
export function toolCardSize(tool: ToolCallNode): { w: number; h: number } {
  const cached = getToolCardSize(tool.id)
  if (cached) return cached
  const labelLen = (`${tool.toolName}: ${tool.args}`).length * HIT_DETECTION.toolCharWidth + 12
  return {
    w: Math.max(60, Math.min(labelLen, TOOL_MAX_CARD_W)),
    h: toolCardExpanded(tool) ? TOOL_DRAW.expandedHeight : TOOL_DRAW.collapsedHeight,
  }
}

/**
 * Find which tool-call card (if any) is at the given canvas-space coordinates.
 * Returns the tool-call id, or null.
 */
export function findToolCallAt(
  x: number,
  y: number,
  toolCalls: Map<string, ToolCallNode>,
  scale = 1,
): string | null {
  for (const [id, tool] of reverseEntries(toolCalls)) {
    if (tool.opacity < MIN_VISIBLE_OPACITY) continue
    const { w, h } = toolCardSize(tool)
    if (pointInMinRect(x, y, tool.x - w / 2, tool.y - h / 2, w, h, scale, HIT_DETECTION.minTargetPx)) return id
  }
  return null
}

/**
 * Find which agent's message bubble (if any) is at the given canvas-space coordinates.
 * Returns the agent id, or null.
 */
export function findBubbleAgentAt(
  x: number,
  y: number,
  agents: Map<string, Agent>,
  currentTime: number,
  scale = 1,
): string | null {
  for (const agent of reverseValues(agents.values())) {
    if (agent.messageBubbles.length === 0 || !isAgentVisible(agent)) continue
    const radius = agentDrawRadius(agent)
    // Collapsed into a count chip: the chip is the only target
    const chip = overlayHits.collapsedBubbles.get(agent.id)
    if (chip) {
      if (pointInMinRect(x, y, chip.x, chip.y, chip.w, chip.h, scale, HIT_DETECTION.minTargetPx)) return agent.id
      continue
    }
    const anchorX = agent.x + radius + AGENT_DRAW.bubbleAnchorOffset
    let cursorY = agent.y + AGENT_DRAW.bubbleCursorY
    const held = isExpiryHeld('agent', agent.id)
    for (const bubble of agent.messageBubbles) {
      const age = currentTime - bubble.time
      const alpha = bubbleAlpha(age, agentDrawOpacity(agent), held)
      if (alpha < 0.01) continue

      // Use cached dimensions from the draw pass when available;
      // fall back to char-width estimation for the first frame.
      let bubbleW: number
      let bubbleH: number
      if (bubble._cachedW != null && bubble._cachedH != null) {
        bubbleW = bubble._cachedW
        bubbleH = bubble._cachedH
      } else {
        const isThinking = bubble.role === 'thinking'
        const style = isThinking ? BUBBLE_DRAW.thinking : BUBBLE_DRAW.normal
        const charW = HIT_DETECTION.bubbleCharWidth
        const maxChars = Math.floor((BUBBLE_MAX_W - style.padding * 2) / charW)
        let lineCount = 0
        for (const para of bubble.text.split('\n')) {
          if (para.trim() === '') { lineCount++; continue }
          const words = para.split(/\s+/)
          let line = ''
          for (const word of words) {
            if (line && (line + ' ' + word).length > maxChars) { lineCount++; line = word }
            else line = line ? line + ' ' + word : word
          }
          if (line) lineCount++
        }
        if (lineCount === 0) lineCount = 1
        bubbleW = BUBBLE_MAX_W
        bubbleH = style.headerH + lineCount * style.lineH + style.padding
      }

      if (pointInMinRect(x, y, anchorX, cursorY, bubbleW, bubbleH, scale, HIT_DETECTION.minTargetPx)) {
        return agent.id
      }
      cursorY += bubbleH + BUBBLE_GAP
    }
  }
  return null
}

/**
 * Find which discovery card (if any) is at the given canvas-space coordinates.
 * Returns the discovery id, or null.
 */
export function findDiscoveryAt(
  x: number,
  y: number,
  discoveries: Discovery[],
  scale = 1,
): string | null {
  for (const disc of reverseValues(discoveries)) {
    if (disc.opacity < MIN_VISIBLE_OPACITY) continue
    // Same dimensions as drawDiscoveries (shared helper)
    const lines = disc.content.split('\n')
    const { cardW, cardH } = getDiscoveryCardDimensions(disc.label, lines)
    if (pointInMinRect(x, y, disc.x - cardW / 2, disc.y - cardH / 2, cardW, cardH, scale, HIT_DETECTION.minTargetPx)) return disc.id
  }
  return null
}

/** Edge bubble (message anchored on a link) under the point: the link id, or null. Last placed wins. */
export function findEdgeBubbleAt(x: number, y: number, scale = 1): string | null {
  let found: string | null = null
  for (const [id, r] of overlayHits.edgeBubbles) {
    if (pointInMinRect(x, y, r.x, r.y, r.w, r.h, scale, HIT_DETECTION.minTargetPx)) found = id
  }
  return found
}

/** Cluster label chip under the point: the cluster key, or null. */
export function findClusterLabelAt(x: number, y: number, scale = 1): string | null {
  let found: string | null = null
  for (const [key, r] of overlayHits.clusterLabels) {
    if (pointInMinRect(x, y, r.x, r.y, r.w, r.h, scale, HIT_DETECTION.minTargetPx)) found = key
  }
  return found
}

export type HitTarget =
  | { type: 'cluster'; id: string }
  | { type: 'agent'; id: string }
  | { type: 'tool'; id: string }
  | { type: 'discovery'; id: string }
  | { type: 'bubble'; id: string }
  | { type: 'link'; id: string }

/**
 * Single hit test with the same priority as the draw order (top first):
 * agent, tool card, discovery card, agent bubble, edge bubble, cluster label, then communication links
 * (drawn under the nodes). An edge bubble reports its link.
 */
export function hitTestAt(
  x: number,
  y: number,
  scene: { agents: Map<string, Agent>; toolCalls: Map<string, ToolCallNode>; discoveries: Discovery[]; links?: ResolvedLink[] },
  simTime: number,
  scale = 1,
): HitTarget | null {
  const agentId = findAgentAt(x, y, scene.agents, scale)
  if (agentId) return { type: 'agent', id: agentId }
  const toolId = findToolCallAt(x, y, scene.toolCalls, scale)
  if (toolId) return { type: 'tool', id: toolId }
  const discId = findDiscoveryAt(x, y, scene.discoveries, scale)
  if (discId) return { type: 'discovery', id: discId }
  const bubbleId = findBubbleAgentAt(x, y, scene.agents, simTime, scale)
  if (bubbleId) return { type: 'bubble', id: bubbleId }
  const edgeBubbleId = findEdgeBubbleAt(x, y, scale)
  if (edgeBubbleId) return { type: 'link', id: edgeBubbleId }
  const clusterId = findClusterLabelAt(x, y, scale)
  if (clusterId) return { type: 'cluster', id: clusterId }
  if (scene.links && scene.links.length > 0) {
    const linkId = findLinkAt(x, y, scene.links, scene.agents, scale, undefined, lodForZoom(scale).labels)
    if (linkId) return { type: 'link', id: linkId }
  }
  return null
}

/** Outline of a focused node, for the keyboard focus ring. Null when the node is gone. */
export function focusShapeFor(
  node: NavNode,
  scene: { agents: Map<string, Agent>; toolCalls: Map<string, ToolCallNode>; discoveries: Discovery[] },
): FocusShape | null {
  if (node.type === 'agent') {
    const a = scene.agents.get(node.id)
    if (!a) return null
    return { kind: 'hex', x: a.x, y: a.y, r: agentDrawRadius(a) }
  }
  if (node.type === 'tool') {
    const t = scene.toolCalls.get(node.id)
    if (!t) return null
    const { w, h } = toolCardSize(t)
    return { kind: 'rect', x: t.x, y: t.y, w, h }
  }
  const d = scene.discoveries.find(x => x.id === node.id)
  if (!d) return null
  const { cardW, cardH } = getDiscoveryCardDimensions(d.label, d.content.split('\n'))
  return { kind: 'rect', x: d.x, y: d.y, w: cardW, h: cardH }
}
