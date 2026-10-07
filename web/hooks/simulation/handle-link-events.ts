import type { MutableEventState } from './process-event'
import {
  agentKeyOf, cappedString, edgeId, nextMsgId, DEFAULT_SESSION_ID, MAX_LINK_MESSAGES,
  type AgentLink, type ConversationMessage, type LinkKind,
} from './types'
import { idString } from './agent-keys'

interface LinkIdentity { id: string; from: string; to: string; kind: LinkKind; sessionId: string }

/** Create the link if needed (keeping its first kind) and append a message, capped at MAX_LINK_MESSAGES. */
export function addLinkMessage(
  state: MutableEventState,
  link: LinkIdentity,
  message: Omit<ConversationMessage, 'id'>,
): void {
  const existing = state.links.get(link.id)
  const base: AgentLink = existing ?? { ...link, messages: [], dropped: 0 }
  const all = [...base.messages, { id: nextMsgId(), ...message }]
  const over = Math.max(0, all.length - MAX_LINK_MESSAGES)
  state.links.set(link.id, {
    ...base,
    messages: over > 0 ? all.slice(over) : all,
    dropped: base.dropped + over,
  })
}

/** Create the link without adding a message (agent_link without content). */
function ensureLink(state: MutableEventState, link: LinkIdentity): void {
  if (!state.links.has(link.id)) state.links.set(link.id, { ...link, messages: [], dropped: 0 })
}

function linkKind(v: unknown): LinkKind {
  return v === 'spawn' ? 'spawn' : 'teammate'
}

interface ParsedLink {
  link: LinkIdentity
  content: string
  toolUseId?: string
}

/** Validate an agent_link / message_sent payload (untrusted); null when it cannot name two agents. */
function parseLinkPayload(payload: Record<string, unknown>, sessionId: string): ParsedLink | null {
  const fromLocal = idString(payload.from)
  const toLocal = idString(payload.to)
  if (!fromLocal || !toLocal) return null
  const from = agentKeyOf(sessionId, fromLocal)
  const to = agentKeyOf(sessionId, toLocal)
  const kind = linkKind(payload.kind)
  const id = idString(payload.linkId) || edgeId(from, to)
  return {
    link: { id, from, to, kind, sessionId },
    content: cappedString(payload.content),
    toolUseId: idString(payload.toolUseId) || undefined,
  }
}

/** agent_link: declare a link between two agents (spawn or teammate). Optional content becomes its first message. */
export function handleAgentLink(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const parsed = parseLinkPayload(payload, sessionId)
  if (!parsed) return
  if (parsed.content) {
    addLinkMessage(state, parsed.link, {
      type: 'message', content: parsed.content, timestamp: currentTime,
      from: parsed.link.from, to: parsed.link.to, linkId: parsed.link.id, toolUseId: parsed.toolUseId,
    })
  } else {
    ensureLink(state, parsed.link)
  }
}

/** message_sent: a message travelling over a link (creates the link when it was not declared). */
export function handleMessageSent(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const parsed = parseLinkPayload(payload, sessionId)
  if (!parsed) return
  addLinkMessage(state, parsed.link, {
    type: 'message', content: parsed.content, timestamp: currentTime,
    from: parsed.link.from, to: parsed.link.to, linkId: parsed.link.id, toolUseId: parsed.toolUseId,
  })
}
