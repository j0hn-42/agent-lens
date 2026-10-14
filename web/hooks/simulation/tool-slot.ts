/**
 * Placement of a new tool card around its agent: the first free slot on rings of growing radius, swept
 * away from the parent. Pure.
 */
import type { Agent, ToolCallNode } from '../../lib/agent-types'
import { TOOL_CARD_W, TOOL_CARD_H, TOOL_SLOT, BUBBLE_VISIBLE_S } from '../../lib/canvas-constants'

/** Farthest a candidate slot can be from its agent */
const MAX_SLOT_DISTANCE = TOOL_SLOT.baseDistance + TOOL_SLOT.maxRings * TOOL_SLOT.ringIncrement

export function findToolSlot(
  agent: Agent, agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>, currentTime: number,
): { x: number; y: number } {
  const visibleBubbles = agent.messageBubbles.filter(b => currentTime - b.time <= BUBBLE_VISIBLE_S)
  const bubbleRect = visibleBubbles.length > 0 ? {
    x1: agent.x + 30, y1: agent.y - 30,
    x2: agent.x + 300, y2: agent.y - 20 + visibleBubbles.length * 60 + 20,
  } : null

  // Only the cards near the agent can overlap a candidate: one pass over the tool calls (#210), instead of
  // one per candidate slot
  const near: ToolCallNode[] = []
  for (const tc of toolCalls.values()) {
    if (Math.abs(tc.x - agent.x) < MAX_SLOT_DISTANCE + TOOL_CARD_W && Math.abs(tc.y - agent.y) < MAX_SLOT_DISTANCE + TOOL_CARD_H) near.push(tc)
  }

  const overlaps = (cx: number, cy: number) => {
    if (bubbleRect && cx + TOOL_CARD_W / 2 > bubbleRect.x1 && cx - TOOL_CARD_W / 2 < bubbleRect.x2
      && cy + TOOL_CARD_H / 2 > bubbleRect.y1 && cy - TOOL_CARD_H / 2 < bubbleRect.y2) return true
    for (const tc of near) {
      if (Math.abs(cx - tc.x) < TOOL_CARD_W && Math.abs(cy - tc.y) < TOOL_CARD_H) return true
    }
    return false
  }

  let outAngle = -Math.PI / 2
  if (agent.parentId) {
    const parent = agents.get(agent.parentId)
    if (parent) {
      outAngle = Math.atan2(agent.y - parent.y, agent.x - parent.x)
    }
  }

  for (let ring = 1; ring <= TOOL_SLOT.maxRings; ring++) {
    const dist = TOOL_SLOT.baseDistance + ring * TOOL_SLOT.ringIncrement
    const steps = TOOL_SLOT.baseSteps + ring * TOOL_SLOT.stepsPerRing
    for (let i = 0; i < steps; i++) {
      const sweep = (i / (steps - 1) - 0.5) * Math.PI
      const angle = outAngle + sweep
      const cx = agent.x + Math.cos(angle) * dist
      const cy = agent.y + Math.sin(angle) * dist
      if (!overlaps(cx, cy)) return { x: cx, y: cy }
    }
  }
  return { x: agent.x + Math.cos(outAngle) * TOOL_SLOT.fallbackDistance, y: agent.y + Math.sin(outAngle) * TOOL_SLOT.fallbackDistance }
}
