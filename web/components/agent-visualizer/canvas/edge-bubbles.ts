/**
 * Pure model of the message bubbles anchored on communication edges (issue #41): the latest message
 * of a link is shown on the edge, a third of the way from its SENDER (so a dispatch sits near the
 * parent and a return near the child), on three lines at most. Clicking it opens the link panel.
 * No React and no canvas: unit-testable under node:test (relative runtime imports only).
 */
import type { Agent } from '../../../lib/agent-types'
import type { ConversationMessage } from '../../../hooks/simulation/types'
import { EDGE_BUBBLE } from '../../../lib/canvas-constants'
import { linkCurve, curvePoint, resolveAgentRef, type ResolvedLink } from './link-geometry'
import { cleanText, wrapLabel, type MeasureText } from './team-style'

export interface EdgeBubble {
  linkId: string
  messageId: string
  type: 'dispatch' | 'return' | 'message'
  isError: boolean
  /** The sender is the link's `from` side (a dispatch travels from the parent) */
  fromSender: boolean
  /** At most EDGE_BUBBLE.maxLines lines, the first one prefixed with the direction arrow */
  lines: string[]
  /** The text did not fit in the lines */
  truncated: boolean
  /** Anchor on the curve (world px) */
  anchor: { x: number; y: number }
  /** Bubble size (world px) */
  w: number
  h: number
}

/** Rough monospace text width (px) at the bubble font size, used when no canvas measure is available. */
export function estimateTextWidth(text: string, fontSize: number = EDGE_BUBBLE.fontSize): number {
  return text.length * fontSize * 0.6
}

function messageType(m: ConversationMessage): EdgeBubble['type'] {
  return m.type === 'dispatch' ? 'dispatch' : m.type === 'return' ? 'return' : 'message'
}

/**
 * Bubble of a link, or null. The latest message shows while it is younger than `EDGE_BUBBLE.visibleS`
 * simulation seconds, or for as long as `held` (hovered / selected link, paused playback, "keep cards visible").
 */
export function selectEdgeBubble(
  r: ResolvedLink,
  agents: Map<string, Agent>,
  simTime: number,
  held = false,
  measure: MeasureText = t => estimateTextWidth(t),
): EdgeBubble | null {
  const msgs = r.link.messages
  const m = msgs[msgs.length - 1]
  if (!m) return null
  const age = simTime - m.timestamp
  if (!held && !(age >= 0 && age <= EDGE_BUBBLE.visibleS)) return null
  const curve = linkCurve(r, agents)
  if (!curve) return null

  const senderKey = m.from ? resolveAgentRef(m.from, r.link.sessionId, agents) : null
  const type = messageType(m)
  // Unknown sender: a dispatch comes from the parent side, anything else from the receiving side
  const fromSender = senderKey ? senderKey === r.fromKey : type !== 'return'
  const t = fromSender ? EDGE_BUBBLE.anchorT : 1 - EDGE_BUBBLE.anchorT
  const anchor = curvePoint(curve, t)

  const text = cleanText(m.content, EDGE_BUBBLE.maxChars) || (m.isError ? 'error' : '(empty message)')
  const arrow = fromSender ? '→' : '←'
  const maxTextW = EDGE_BUBBLE.maxWidth - EDGE_BUBBLE.padding * 2
  const { lines, truncated } = wrapLabel(`${arrow} ${text}`, maxTextW, measure, EDGE_BUBBLE.maxLines)
  const longest = Math.max(...lines.map(measure))
  return {
    linkId: r.id,
    messageId: m.id,
    type,
    isError: !!m.isError,
    fromSender,
    lines,
    truncated,
    anchor,
    w: Math.min(EDGE_BUBBLE.maxWidth, Math.ceil(longest) + EDGE_BUBBLE.padding * 2),
    h: lines.length * EDGE_BUBBLE.lineHeight + EDGE_BUBBLE.padding * 2,
  }
}
