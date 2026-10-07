/**
 * Pure model of the link panel: the chronological list of a link's messages with sender, receiver,
 * direction and time. No React: unit-testable under node:test (relative runtime imports only).
 * Message text is untrusted (it comes from transcripts and inboxes): control characters are removed
 * and the length is capped, but newlines are kept so the full content stays readable.
 */
import type { Agent } from '../../../lib/agent-types'
import type { AgentLink, ConversationMessage } from '../../../hooks/simulation/types'
import { resolveAgentRef } from './link-geometry'
import { cleanText } from './team-style'

/** A message with more characters or lines than this starts collapsed */
export const LINK_MESSAGE_COLLAPSE_CHARS = 400
export const LINK_MESSAGE_COLLAPSE_LINES = 6
/** Hard cap on the characters of one message shown in the panel */
export const LINK_MESSAGE_MAX_CHARS = 4000

export type LinkEntryType = 'dispatch' | 'return' | 'message'

export interface LinkPanelEntry {
  id: string
  type: LinkEntryType
  /** 'DISPATCH' | 'RETURN' | 'MESSAGE' */
  typeLabel: string
  senderName: string
  receiverName: string
  /** '→' when the message travels from the link's `from` side to its `to` side, '←' otherwise */
  arrow: '→' | '←'
  /** "main to Explorer" (read by assistive technology instead of the arrow glyph) */
  directionText: string
  timeText: string
  content: string
  /** Collapsed by default (long content) */
  long: boolean
  isError: boolean
}

export interface LinkPanelModel {
  title: string
  fromName: string
  toName: string
  kindLabel: string
  entries: LinkPanelEntry[]
  /** Set when older messages were dropped (cap per link) */
  droppedText: string | null
  /** Short summary for the dialog description */
  summary: string
}

// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g')

/** Strip control characters (keeping \n and \t), normalise newlines and cap the length. */
export function cleanMessageText(value: unknown, max = LINK_MESSAGE_MAX_CHARS): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE, ' ')
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** "m:ss" of a time in seconds (never negative, never NaN). */
export function formatLinkTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

/** Should this message start collapsed? */
export function isLongMessage(content: string): boolean {
  return content.length > LINK_MESSAGE_COLLAPSE_CHARS || content.split('\n').length > LINK_MESSAGE_COLLAPSE_LINES
}

function typeOf(m: ConversationMessage): LinkEntryType {
  return m.type === 'dispatch' || m.type === 'return' ? m.type : 'message'
}

export function buildLinkPanelModel(link: AgentLink, agents: Map<string, Agent>): LinkPanelModel {
  const nameOf = (ref: string): string => {
    const key = resolveAgentRef(ref, link.sessionId, agents)
    return cleanText((key ? agents.get(key)?.name : undefined) ?? ref, 80) || 'agent'
  }
  const fromKey = resolveAgentRef(link.from, link.sessionId, agents)
  const fromName = nameOf(link.from)
  const toName = nameOf(link.to)

  // Chronological, stable for equal timestamps
  const ordered = link.messages
    .map((m, index) => ({ m, index }))
    .sort((a, b) => (a.m.timestamp - b.m.timestamp) || (a.index - b.index))

  const entries: LinkPanelEntry[] = ordered.map(({ m }) => {
    const type = typeOf(m)
    // Sender: explicit field, else implied by the kind (a return travels from the child back to the parent)
    const senderRef = m.from ?? (type === 'return' ? link.to : link.from)
    const receiverRef = m.to ?? (type === 'return' ? link.from : link.to)
    const senderKey = resolveAgentRef(senderRef, link.sessionId, agents)
    const forward = senderKey != null && fromKey != null ? senderKey === fromKey : senderRef === link.from
    const senderName = nameOf(senderRef)
    const receiverName = nameOf(receiverRef)
    const content = cleanMessageText(m.content)
    return {
      id: m.id,
      type,
      typeLabel: type.toUpperCase(),
      senderName,
      receiverName,
      arrow: forward ? '→' : '←',
      directionText: `${senderName} to ${receiverName}`,
      timeText: formatLinkTime(m.timestamp),
      content,
      long: isLongMessage(content),
      isError: !!m.isError,
    }
  })

  const total = link.messages.length + (link.dropped || 0)
  return {
    title: `${fromName} and ${toName}`,
    fromName,
    toName,
    kindLabel: link.kind === 'spawn' ? 'Task and report' : 'Teammate messages',
    entries,
    droppedText: link.dropped > 0 ? `${link.dropped} older ${link.dropped === 1 ? 'message was' : 'messages were'} dropped` : null,
    summary: `${total} ${total === 1 ? 'message' : 'messages'}`,
  }
}
