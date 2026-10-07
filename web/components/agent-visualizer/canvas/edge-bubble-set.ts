/**
 * Several bubbles per link (issue #41): a dispatch sits a third of the way from the parent along the
 * curve, a return a third of the way from the child, a teammate (peer) message at the midpoint. Up to
 * EDGE_BUBBLE.maxPerLink bubbles per link and EDGE_BUBBLE.maxTotal on the canvas. A bubble expires after
 * EDGE_BUBBLE.visibleS simulation seconds unless it is held (hovered / focused bubble, hovered or selected
 * link, paused playback, "Keep cards visible"). Also builds the accessible names and the DOM list entries.
 * No React and no canvas: unit-testable under node:test (relative runtime imports only).
 */
import type { Agent } from '../../../lib/agent-types'
import type { AgentLink, ConversationMessage } from '../../../hooks/simulation/types'
import { EDGE_BUBBLE } from '../../../lib/canvas-constants'
import { linkCurve, curvePoint, resolveAgentRef, type ResolvedLink } from './link-geometry'
import { cleanText, wrapLabel, type MeasureText } from './team-style'
import { estimateTextWidth, type EdgeBubble } from './edge-bubbles'

/** A bubble of the set: an EdgeBubble plus its identity, accessible name and group info. */
export interface KeyedEdgeBubble extends EdgeBubble {
  /** Unique id of the bubble (planner key, DOM button key) */
  key: string
  timestamp: number
  /** Accessible name of the bubble button */
  ariaLabel: string
  /** Live bubbles on the same link (the count shown on the collapsed chip) */
  groupCount: number
  /** The newest bubble of its link: the only one that may collapse to a count chip */
  primary: boolean
}

export type EdgeMessageKind = 'dispatch' | 'return' | 'message'

const KIND_LABEL: Readonly<Record<EdgeMessageKind, string>> = {
  dispatch: 'dispatch',
  return: 'return',
  message: 'peer message',
}

export function bubbleKey(linkId: string, messageId: string): string {
  return `${linkId}|${messageId}`
}

/** Only dispatch / return / teammate messages are communication messages (tool traffic is not). */
export function edgeMessageKind(m: Pick<ConversationMessage, 'type'>): EdgeMessageKind | null {
  return m.type === 'dispatch' || m.type === 'return' || m.type === 'message' ? m.type : null
}

/** Position on the curve (0 = parent side): 1/3 for a dispatch, 2/3 for a return, the middle for a peer message. */
export function anchorTFor(kind: EdgeMessageKind): number {
  return kind === 'dispatch' ? EDGE_BUBBLE.anchorT : kind === 'return' ? 1 - EDGE_BUBBLE.anchorT : EDGE_BUBBLE.peerT
}

/** First words of a text, for an accessible name. */
export function firstWords(text: unknown, words: number = EDGE_BUBBLE.ariaWords): string {
  const clean = cleanText(text, 400)
  if (!clean) return ''
  const parts = clean.split(' ')
  const head = parts.slice(0, Math.max(1, words)).join(' ')
  return parts.length > words ? `${head}…` : head
}

function agentLabel(key: string | null, ref: string, agents: Map<string, Agent>): string {
  const a = key ? agents.get(key) : undefined
  return cleanText(a?.displayName || a?.name || ref, 60) || 'unknown agent'
}

export interface MessageEnds {
  senderKey: string | null
  receiverKey: string | null
  /** The message travels from the link's `from` side */
  fromSender: boolean
}

/** Sender and receiver of a link message; an unknown sender defaults to the parent side for a dispatch. */
export function messageEnds(r: ResolvedLink, m: ConversationMessage, kind: EdgeMessageKind, agents: Map<string, Agent>): MessageEnds {
  const sender = m.from ? resolveAgentRef(m.from, r.link.sessionId, agents) : null
  const fromSender = sender ? sender === r.fromKey : kind !== 'return'
  return {
    senderKey: fromSender ? r.fromKey : r.toKey,
    receiverKey: fromSender ? r.toKey : r.fromKey,
    fromSender,
  }
}

/** "Explorer to Main, dispatch: Find the bug in…" */
export function edgeBubbleAriaLabel(sender: string, receiver: string, kind: EdgeMessageKind, content: unknown, isError = false): string {
  const words = firstWords(content)
  return `${sender} to ${receiver}, ${KIND_LABEL[kind]}${isError ? ' (error)' : ''}${words ? `: ${words}` : ''}`
}

export interface EdgeBubbleSetOptions {
  /** Every bubble of the link is held (hovered / selected link, paused, keep cards visible) */
  held?: boolean
  /**
   * Message ids held individually (hovered or focused bubble), without their link: a link not holding
   * them must scan its whole list to be sure. Prefer `heldKeys`.
   */
  heldMessageIds?: ReadonlySet<string>
  /** Bubble keys (`bubbleKey(linkId, messageId)`) held individually: only the named link looks further back than maxPerLink */
  heldKeys?: ReadonlySet<string>
  measure?: MeasureText
  maxPerLink?: number
}

/**
 * Bubbles of one link. Candidates are the newest `maxPerLink` communication messages (plus the
 * individually held ones); a candidate shows while younger than `visibleS` or held. Chronological order.
 */
export function selectEdgeBubbles(
  r: ResolvedLink,
  agents: Map<string, Agent>,
  simTime: number,
  options: EdgeBubbleSetOptions = {},
): KeyedEdgeBubble[] {
  const msgs = r.link.messages
  if (msgs.length === 0) return []
  const max = Math.max(0, options.maxPerLink ?? EDGE_BUBBLE.maxPerLink)
  const measure = options.measure ?? (t => estimateTextWidth(t))
  // Held messages outside the newest window: only those of this link count, and the scan stops once all are found
  const heldIds = new Set<string>()
  if (options.heldKeys && options.heldKeys.size > 0) {
    const prefix = `${r.id}|`
    for (const k of options.heldKeys) if (k.startsWith(prefix)) heldIds.add(k.slice(prefix.length))
  }
  if (options.heldMessageIds) for (const id of options.heldMessageIds) heldIds.add(id)
  let heldLeft = heldIds.size

  const picked: ConversationMessage[] = []
  let windowCount = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!edgeMessageKind(m)) {
      if (windowCount >= max && heldLeft === 0) break
      continue
    }
    const isHeld = heldIds.has(m.id)
    if (isHeld) heldLeft--
    if (windowCount < max) { picked.push(m); windowCount++ } else if (isHeld) picked.push(m)
    if (windowCount >= max && heldLeft <= 0) break
  }
  if (picked.length === 0) return []
  const curve = linkCurve(r, agents)
  if (!curve) return []

  const out: KeyedEdgeBubble[] = []
  for (const m of picked) {
    const kind = edgeMessageKind(m)!
    const age = simTime - m.timestamp
    const held = !!options.held || heldIds.has(m.id)
    if (!held && !(age >= 0 && age <= EDGE_BUBBLE.visibleS)) continue

    const ends = messageEnds(r, m, kind, agents)
    const anchor = curvePoint(curve, anchorTFor(kind))
    const text = cleanText(m.content, EDGE_BUBBLE.maxChars) || (m.isError ? 'error' : '(empty message)')
    const arrow = ends.fromSender ? '→' : '←'
    const maxTextW = EDGE_BUBBLE.maxWidth - EDGE_BUBBLE.padding * 2
    const { lines, truncated } = wrapLabel(`${arrow} ${text}`, maxTextW, measure, EDGE_BUBBLE.maxLines)
    const longest = Math.max(...lines.map(measure))
    out.push({
      key: bubbleKey(r.id, m.id),
      linkId: r.id,
      messageId: m.id,
      type: kind,
      isError: !!m.isError,
      fromSender: ends.fromSender,
      lines,
      truncated,
      anchor,
      w: Math.min(EDGE_BUBBLE.maxWidth, Math.ceil(longest) + EDGE_BUBBLE.padding * 2),
      h: lines.length * EDGE_BUBBLE.lineHeight + EDGE_BUBBLE.padding * 2,
      timestamp: m.timestamp,
      ariaLabel: edgeBubbleAriaLabel(
        agentLabel(ends.senderKey, ends.fromSender ? r.link.from : r.link.to, agents),
        agentLabel(ends.receiverKey, ends.fromSender ? r.link.to : r.link.from, agents),
        kind, m.content, !!m.isError,
      ),
      groupCount: 0,
      primary: false,
    })
  }
  out.sort((a, b) => a.timestamp - b.timestamp)
  for (const b of out) b.groupCount = out.length
  if (out.length > 0) out[out.length - 1].primary = true
  return out
}

/** Keep the newest `max` bubbles of the canvas (stable: chronological order is kept). Group counts are recomputed. */
export function capEdgeBubbles(bubbles: KeyedEdgeBubble[], max: number = EDGE_BUBBLE.maxTotal): KeyedEdgeBubble[] {
  if (bubbles.length <= max) return bubbles
  const keep = new Set(
    bubbles.map((b, i) => ({ b, i })).sort((a, c) => (c.b.timestamp - a.b.timestamp) || (c.i - a.i)).slice(0, Math.max(0, max)).map(x => x.b.key),
  )
  const kept = bubbles.filter(b => keep.has(b.key))
  const perLink = new Map<string, KeyedEdgeBubble[]>()
  for (const b of kept) {
    const list = perLink.get(b.linkId) ?? []
    list.push(b)
    perLink.set(b.linkId, list)
  }
  for (const list of perLink.values()) {
    list.forEach(b => { b.groupCount = list.length; b.primary = false })
    list[list.length - 1].primary = true
  }
  return kept
}

// ─── DOM list entries (graph-a11y-list) ──────────────────────────────────────

export interface LinkMessageItem {
  id: string
  linkId: string
  text: string
}

/** The newest messages of each link as list entries ("Explorer to Main, return: Found 3 files"). */
export function buildLinkMessageItems(
  links: Map<string, AgentLink> | undefined,
  agents: Map<string, Agent>,
  perLink: number = EDGE_BUBBLE.listedPerLink,
): LinkMessageItem[] {
  const items: LinkMessageItem[] = []
  if (!links) return items
  for (const [id, link] of links) {
    const fromKey = resolveAgentRef(link.from, link.sessionId, agents)
    const toKey = resolveAgentRef(link.to, link.sessionId, agents)
    if (!fromKey || !toKey || fromKey === toKey) continue
    const r = { id, link, fromKey, toKey } as ResolvedLink
    let n = 0
    const mine: LinkMessageItem[] = []
    for (let i = link.messages.length - 1; i >= 0 && n < perLink; i--) {
      const m = link.messages[i]
      const kind = edgeMessageKind(m)
      if (!kind) continue
      n++
      const ends = messageEnds(r, m, kind, agents)
      mine.push({
        id: bubbleKey(id, m.id),
        linkId: id,
        text: edgeBubbleAriaLabel(
          agentLabel(ends.senderKey, '', agents), agentLabel(ends.receiverKey, '', agents), kind, m.content, !!m.isError,
        ),
      })
    }
    items.push(...mine.reverse())
  }
  return items
}
