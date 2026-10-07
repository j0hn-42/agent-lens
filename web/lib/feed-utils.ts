// Pure helpers shared by the Conversation panel and the tool content views.
// Kept free of React / path-alias imports so they can be unit tested with node:test.

// State labels live in state-labels.ts (single source of truth); re-exported for feed consumers.
export { STATE_LABELS, getStateLabel as stateLabel } from './state-labels'

import type { ConversationMessage, AgentLink } from '../hooks/simulation/types'
import type { TeamSummary } from './agent-types'
import { formatDroppedMessages } from './chrome-utils'
import { findTeam } from '../hooks/simulation/team-key'
import { emptyState, emptyMatch } from './ui-glossary'

/** Single empty-state wording used by every message list (see ui-glossary.ts). */
export const EMPTY_MESSAGES = emptyState('messages')
export const EMPTY_SEARCH = emptyMatch('messages')

/** The one truncation rule of the Conversation panel: longer messages collapse to this many characters, with "Show all". */
export const COLLAPSED_TEXT_MAX = 120

/**
 * Truncate text and report how many characters were hidden.
 * The marker is '… (+N chars)'.
 */
export function truncateWithMarker(text: string, max: number): { text: string; hidden: number; marker: string } {
  if (text.length <= max) return { text, hidden: 0, marker: '' }
  const hidden = text.length - max
  return { text: text.slice(0, max), hidden, marker: `… (+${hidden} chars)` }
}

/** Format simulation seconds as m:ss and an ISO-8601 duration for <time dateTime>. */
export function formatElapsed(seconds: number): { label: string; iso: string } {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const whole = Math.floor(s)
  const m = Math.floor(whole / 60)
  const rem = String(whole % 60).padStart(2, '0')
  return { label: `${m}:${rem}`, iso: `PT${s.toFixed(1)}S` }
}

/**
 * Which agents received new text messages since the last call.
 * `prevLens` holds raw conversation lengths per agent; returns the next lengths.
 */
export function agentsWithNewText(
  prevLens: ReadonlyMap<string, number>,
  conversations: ReadonlyMap<string, readonly { type: string }[]>,
  textTypes: ReadonlySet<string>,
): { increased: string[]; nextLens: Map<string, number> } {
  const increased: string[] = []
  const nextLens = new Map<string, number>()
  for (const [agentId, msgs] of conversations) {
    const prev = prevLens.get(agentId) ?? 0
    nextLens.set(agentId, msgs.length)
    for (let i = prev; i < msgs.length; i++) {
      if (textTypes.has(msgs[i].type)) { increased.push(agentId); break }
    }
  }
  return { increased, nextLens }
}

/** Roving-tabindex keyboard navigation for tablists. Returns next index or null. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight': case 'ArrowDown': return (current + 1) % count
    case 'ArrowLeft': case 'ArrowUp': return (current - 1 + count) % count
    case 'Home': return 0
    case 'End': return count - 1
    default: return null
  }
}

/** Lists below this size are rendered in full (no windowing). */
export const VIRTUALIZE_THRESHOLD = 200

/**
 * Final render window for a list. Small lists render in full; larger ones use the
 * computed window, widened so the item holding keyboard focus is never unmounted.
 */
export function resolveRenderWindow(
  count: number,
  start: number,
  end: number,
  focusedIndex: number,
  threshold: number = VIRTUALIZE_THRESHOLD,
): { start: number; end: number; virtualized: boolean } {
  if (count < threshold) return { start: 0, end: count, virtualized: false }
  let s = Math.max(0, Math.min(start, count))
  let e = Math.max(s, Math.min(end, count))
  if (focusedIndex >= 0 && focusedIndex < count) {
    if (focusedIndex < s) s = focusedIndex
    if (focusedIndex >= e) e = focusedIndex + 1
  }
  return { start: s, end: e, virtualized: true }
}

/** Keep the first `max` lines and report how many were hidden ('… (+N lines)'). */
export function truncateLines(text: string, max: number): { lines: string[]; hidden: number } {
  const all = text.split('\n')
  return { lines: all.slice(0, max), hidden: Math.max(0, all.length - max) }
}

/** Unread tab keys after new text arrived: never mark the active tab, nor 'all'. */
export function markUnread(
  prev: ReadonlySet<string>,
  increased: readonly string[],
  activeTab: string,
): Set<string> {
  const next = new Set(prev)
  if (activeTab === 'all') return next
  for (const id of increased) if (id !== activeTab) next.add(id)
  return next
}

/** Index of the active tab; falls back to the first tab so one tab is always tabbable. */
export function activeTabIndexOf(keys: readonly string[], active: string): number {
  return Math.max(0, keys.indexOf(active))
}

/** Visible keyboard focus ring (inset so it is not clipped by scroll containers). */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#aaeeff]'

/** Top offset of the Conversation pill: just under the top bar, which wraps onto several rows on narrow windows. */
export const FEED_TOP = 'calc(var(--topbar-h, 48px) + 8px)'

/**
 * Border of a feed tab as longhand properties only (mixing `border` with `borderBottom` / `borderStyle`
 * makes React log a "conflicting property" error on every re-render). Active tabs get a tinted frame, team
 * members a 2px accent underline, finished agents a dashed frame.
 */
export function tabBorderStyle(opts: { active: boolean; color: string; accent?: string; done?: boolean }): Record<string, string> {
  const frame = opts.active ? `${opts.color}30` : 'transparent'
  const bottom = opts.accent ?? frame
  const style = opts.done ? 'dashed' : 'solid'
  return {
    borderTopWidth: '1px', borderRightWidth: '1px', borderLeftWidth: '1px',
    borderBottomWidth: opts.accent ? '2px' : '1px',
    borderTopStyle: style, borderRightStyle: style, borderLeftStyle: style, borderBottomStyle: style,
    borderTopColor: frame, borderRightColor: frame, borderLeftColor: frame, borderBottomColor: bottom,
  }
}

/** Agents offered by the pair pickers: those with messages plus the ones already chosen elsewhere. */
export function pickerAgentIds(withMessages: readonly string[], pair: { a: string; b: string }): string[] {
  const ids = [...withMessages]
  for (const k of [pair.a, pair.b]) if (k !== '' && !ids.includes(k)) ids.push(k)
  return ids
}

// ─── Agent-to-agent communication (dispatch / return / teammate messages) ────

/** Message types shown as plain conversation text. */
export const TEXT_MESSAGE_TYPES: ReadonlySet<string> = new Set(['assistant', 'user', 'thinking'])
/** Message types that describe a communication between two agents. */
export const COMM_MESSAGE_TYPES: ReadonlySet<string> = new Set(['dispatch', 'return', 'message'])
/** Everything the Conversation panel lists without tool activity (also what the unread tracking and the pill follow). */
export const FEED_MESSAGE_TYPES: ReadonlySet<string> = new Set([...TEXT_MESSAGE_TYPES, ...COMM_MESSAGE_TYPES])
/** Tool activity, listed in the Conversation panel when "Tool calls" is on. */
export const TOOL_MESSAGE_TYPES: ReadonlySet<string> = new Set(['tool_call', 'tool_result'])

export type CommKind = 'dispatch' | 'return' | 'return_error' | 'message'

export const COMM_LABELS: Record<CommKind, string> = {
  dispatch: 'DISPATCH',
  return: 'RETURN',
  return_error: 'RETURN (ERROR)',
  message: 'MESSAGE',
}

/** Kind of communication row, or null for plain conversation messages. */
export function commKindOf(m: { type: string; isError?: boolean }): CommKind | null {
  if (m.type === 'dispatch') return 'dispatch'
  if (m.type === 'return') return m.isError ? 'return_error' : 'return'
  if (m.type === 'message') return 'message'
  return null
}

/** Directional label, e.g. 'orchestrator -> explore'. */
export function directionText(from: string, to: string): string {
  return `${from} -> ${to}`
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** Only '#rrggbb' colors are ever used for styling (untrusted team data). */
export function safeHexColor(color: unknown): string | undefined {
  return typeof color === 'string' && HEX_COLOR_RE.test(color) ? color : undefined
}

interface NamedAgent {
  name: string
  sessionId?: string
  sessionLabel?: string
  teamName?: string
  teamColor?: string
  kind?: string
  state?: string
  archived?: boolean
  activity?: string
}

/** Display name for an agent key (falls back to the local part of the key). */
export function agentNameOf(agents: ReadonlyMap<string, { name: string }>, key: string): string {
  const a = agents.get(key)
  if (a) return a.name
  const i = key.indexOf(':')
  return i >= 0 ? key.slice(i + 1) : key
}

/** Team accent color of an agent: its own validated color, else the team's member color. */
export function teamColorOf(
  agent: NamedAgent | undefined,
  teams?: ReadonlyMap<string, TeamSummary>,
): string | undefined {
  if (!agent) return undefined
  const own = safeHexColor(agent.teamColor)
  if (own) return own
  if (!agent.teamName || !teams) return undefined
  const team = agent.sessionId !== undefined ? findTeam(teams, agent.teamName, agent.sessionId) : teams.get(agent.teamName)
  const member = team?.members.find(m => m.name === agent.name)
  return safeHexColor(member?.color)
}

/** True when the agents come from more than one session (the feed then shows a session chip). */
export function hasMultipleSessions(agents: ReadonlyMap<string, { sessionId?: string }>): boolean {
  const ids = new Set<string>()
  for (const a of agents.values()) {
    ids.add(a.sessionId ?? '')
    if (ids.size > 1) return true
  }
  return false
}

/** Whether an agent has finished: it keeps its tab, flagged 'done'. Unknown agents count as done. */
export function isAgentDone(agent: NamedAgent | undefined): boolean {
  if (!agent) return true
  return agent.archived === true || agent.state === 'complete' || agent.activity === 'done'
}

export type FeedMessage = ConversationMessage & { agentId: string }

/** Width (simulation seconds) within which two copies of the same message are considered one. */
export const COMM_DEDUPE_BUCKET_S = 2

/** Whitespace-collapsed, lowercased content used to compare message copies. */
export function normalizeCommContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 500)
}

/**
 * Dedupe keys of a communication message. Two copies (conversation + link) of the same message share a
 * key in at least one bucket; distinct messages never share one (content differs). Messages carrying a
 * toolUseId dedupe on it. The time bucket is checked in two adjacent buckets so copies a few
 * milliseconds apart across a bucket edge still merge.
 */
export function commDedupeKeys(m: Pick<ConversationMessage, 'type' | 'from' | 'to' | 'content' | 'timestamp' | 'toolUseId'>): string[] {
  if (m.toolUseId) return [`${m.type}|${m.from ?? ''}|${m.to ?? ''}|id:${m.toolUseId}`]
  const base = `${m.type}|${m.from ?? ''}|${m.to ?? ''}|${normalizeCommContent(m.content)}`
  const b = Math.floor(m.timestamp / COMM_DEDUPE_BUCKET_S)
  return [`${base}|${b}`, `${base}|${b + 1}`, `${base}|${b - 1}`]
}

/**
 * Every feed message of every agent (finished agents included), merged with the messages carried by
 * links, deduplicated and sorted by time. `agentId` is the conversation owner (the sender for
 * messages that only exist on a link).
 */
export function buildFeedMessages(
  conversations: ReadonlyMap<string, readonly ConversationMessage[]>,
  links?: ReadonlyMap<string, Pick<AgentLink, 'from' | 'messages'>>,
  /** Extra message types to list besides FEED_MESSAGE_TYPES (e.g. TOOL_MESSAGE_TYPES) */
  extraTypes?: ReadonlySet<string>,
): FeedMessage[] {
  const out: FeedMessage[] = []
  const seenIds = new Set<string>()
  // Dispatch/return merge on content. Peer 'message' rows merge only with a copy held by ANOTHER source
  // (another agent's conversation, or a link); each copy is consumed once, so identical acks sent in a
  // burst by one sender are all kept.
  const seenComm = new Set<string>()
  const peerCopies = new Map<string, string[]>()
  const push = (m: ConversationMessage, agentId: string, source: string) => {
    if (!(FEED_MESSAGE_TYPES.has(m.type) || extraTypes?.has(m.type)) || seenIds.has(m.id)) return
    if (COMM_MESSAGE_TYPES.has(m.type)) {
      const keys = commDedupeKeys(m)
      if (m.type === 'message' && !m.toolUseId) {
        for (const k of keys) {
          const list = peerCopies.get(k)
          const i = list ? list.findIndex(src => src !== source) : -1
          if (list && i >= 0) { list.splice(i, 1); return }
        }
        const own = peerCopies.get(keys[0]) ?? []
        own.push(source)
        peerCopies.set(keys[0], own)
      } else {
        if (keys.some(k => seenComm.has(k))) return
        // Register only the own bucket so a later message in the next bucket is judged by its own window.
        seenComm.add(keys[0])
      }
    }
    seenIds.add(m.id)
    out.push({ ...m, agentId })
  }
  for (const [agentId, msgs] of conversations) for (const m of msgs) push(m, agentId, `conv:${agentId}`)
  if (links) for (const [linkId, link] of links) for (const m of link.messages) push(m, m.from ?? link.from, `link:${linkId}`)
  return out.sort((a, b) => a.timestamp - b.timestamp)
}

/** Newest feed message (conversations and links), the one the collapsed pill shows; null when there is none. */
export function latestFeedMessage(
  conversations: ReadonlyMap<string, readonly ConversationMessage[]>,
  links?: ReadonlyMap<string, Pick<AgentLink, 'from' | 'messages'>>,
): FeedMessage | null {
  let latest: FeedMessage | null = null
  // Finished agents keep their messages: no filtering on live agents
  for (const [agentId, msgs] of conversations) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!FEED_MESSAGE_TYPES.has(msgs[i].type)) continue
      if (!latest || msgs[i].timestamp > latest.timestamp) latest = { ...msgs[i], agentId }
      break
    }
  }
  if (links) {
    for (const link of links.values()) {
      const last = link.messages[link.messages.length - 1]
      if (last && FEED_MESSAGE_TYPES.has(last.type) && (!latest || last.timestamp > latest.timestamp)) {
        latest = { ...last, agentId: last.from ?? link.from }
      }
    }
  }
  return latest
}

/** Messages whose text or tool name contains the query (case-insensitive); a blank query keeps everything. */
export function filterBySearch<T extends { content: string; toolName?: string }>(messages: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return messages.slice()
  return messages.filter(m => m.content.toLowerCase().includes(q) || (m.toolName ?? '').toLowerCase().includes(q))
}

/** Tab preset by the selected agent: its own tab, or 'all' when nothing is selected. */
export function tabForSelection(selectedAgentId: string | null | undefined): string {
  return selectedAgentId ? selectedAgentId : 'all'
}

/** Messages of one tab: the agent's own messages plus every communication it sent or received. */
export function filterByTab(messages: readonly FeedMessage[], tab: string): FeedMessage[] {
  if (tab === 'all') return messages.slice()
  return messages.filter(m =>
    m.agentId === tab || (COMM_MESSAGE_TYPES.has(m.type) && (m.from === tab || m.to === tab)))
}

/** 'Pair' filter: communications exchanged between exactly the two agents, in either direction. */
export function filterByPair(messages: readonly FeedMessage[], a: string, b: string): FeedMessage[] {
  if (!a || !b || a === b) return []
  return messages.filter(m =>
    COMM_MESSAGE_TYPES.has(m.type)
    && ((m.from === a && m.to === b) || (m.from === b && m.to === a)))
}

/** Dropped-message marker for a tab ('all' sums every agent); null when nothing was dropped. */
export function droppedMarkerFor(
  dropped: ReadonlyMap<string, number> | undefined,
  tab: string,
): string | null {
  if (!dropped) return null
  let n = 0
  if (tab === 'all') for (const v of dropped.values()) n += v
  else n = dropped.get(tab) ?? 0
  return formatDroppedMessages(n)
}

/** Ids of agents that have messages, main first then by name. Finished agents are kept. */
export function agentIdsWithMessages(
  messages: readonly FeedMessage[],
  agents: ReadonlyMap<string, { name: string; isMain?: boolean }>,
): string[] {
  const ids = new Set<string>()
  for (const m of messages) ids.add(m.agentId)
  return [...ids].sort((x, y) => {
    const ax = agents.get(x), ay = agents.get(y)
    if (ax?.isMain && !ay?.isMain) return -1
    if (ay?.isMain && !ax?.isMain) return 1
    return agentNameOf(agents, x).localeCompare(agentNameOf(agents, y))
  })
}

export interface TeamGroup<T> { team: string | null; items: T[] }

/** Group items under their team heading (teams first by name, then those without a team). */
export function groupByTeam<T extends { teamName?: string }>(items: readonly T[]): TeamGroup<T>[] {
  const byTeam = new Map<string, T[]>()
  const rest: T[] = []
  for (const it of items) {
    if (it.teamName) {
      const list = byTeam.get(it.teamName) ?? []
      list.push(it)
      byTeam.set(it.teamName, list)
    } else rest.push(it)
  }
  const groups: TeamGroup<T>[] = [...byTeam.keys()].sort().map(t => ({ team: t, items: byTeam.get(t)! }))
  if (rest.length) groups.push({ team: null, items: rest })
  return groups
}

// ─── Pair filter (click an agent, Shift-click another) ───────────────────────

/** Pair selected by Shift-clicking `key` while `anchor` is the current agent; null when not a valid pair. */
export function pairFromShiftClick(anchor: string | null | undefined, key: string): [string, string] | null {
  if (!anchor || anchor === 'all' || key === 'all' || anchor === key) return null
  return [anchor, key]
}

/** Pair of agents a communication row connects, or null for plain conversation messages. */
export function pairOfMessage(m: Pick<ConversationMessage, 'type' | 'from' | 'to'>): [string, string] | null {
  if (!COMM_MESSAGE_TYPES.has(m.type) || !m.from || !m.to || m.from === m.to) return null
  return [m.from, m.to]
}

/**
 * Per-agent message lists used for unread tracking: conversations plus the link messages each agent
 * sent or received (teammate messages often live only on links).
 */
export function unreadSources(
  conversations: ReadonlyMap<string, readonly { type: string }[]>,
  links?: ReadonlyMap<string, Pick<AgentLink, 'from' | 'to' | 'messages'>>,
): Map<string, { type: string }[]> {
  const out = new Map<string, { type: string }[]>()
  for (const [id, msgs] of conversations) out.set(id, msgs.slice())
  if (links) {
    for (const link of links.values()) {
      for (const m of link.messages) {
        for (const id of new Set([m.from ?? link.from, m.to ?? link.to])) {
          if (!id) continue
          const list = out.get(id) ?? []
          list.push(m)
          out.set(id, list)
        }
      }
    }
  }
  return out
}

// ─── Unread tracking (per source, never by position across merged lists) ─────

export interface UnreadState {
  /** Conversation length last seen per agent (fallback when no last id is known). */
  convLens: Map<string, number>
  /** Id of the newest conversation message already seen per agent (conversations are capped, so length alone is not monotonic). */
  convLast?: Map<string, string>
  /** Timestamp of that newest message: tells a replayed history (same times) from a cap flood (later times) when the id is gone. */
  convLastTs?: Map<string, number>
  /** Ids of link messages already seen. */
  linkSeen: Set<string>
  /** `${agent}|${dedupe key}` of link messages that already flagged an agent, so a late conversation copy does not flag twice. */
  linkKeys?: Set<string>
}

export const emptyUnreadState = (): UnreadState => ({ convLens: new Map(), convLast: new Map(), convLastTs: new Map(), linkSeen: new Set(), linkKeys: new Set() })

/**
 * Index of the first message of `msgs` not yet seen. Uses the id of the newest message seen last time
 * (robust to the conversation cap dropping the oldest messages). When that message is gone the history
 * was replaced (timeline seek, restart, session switch: the replay assigns fresh ids), so the list is
 * compared by event time: only messages later than the last seen one are new. Without a stored id it
 * falls back to the stored length.
 */
function firstUnseenIndex(msgs: readonly { id: string; timestamp?: number }[], lastId: string | undefined, lenBefore: number | undefined, lastTs?: number): number {
  if (lastId !== undefined) {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id === lastId) return i + 1
    // The id is gone. Either the history was replayed (seek/restart: fresh ids, same event times) or a
    // flood pushed every seen message out of the cap (later times). Only messages later than the last
    // seen one are new; without a stored time everything is treated as already seen.
    if (lastTs === undefined) return msgs.length
    let i = 0
    while (i < msgs.length && (msgs[i].timestamp ?? 0) <= lastTs) i++
    return i
  }
  return Math.min(lenBefore ?? 0, msgs.length)
}

/**
 * Agents that received a new text message since `prev`. Conversations are compared by the id of their
 * newest seen message (new tail only); link messages by id, and a link copy of a message already present
 * in an endpoint's conversation (or a conversation copy of a link message that already flagged) is not new.
 * Non-text events never flag an agent.
 */
export function trackUnread(
  prev: UnreadState,
  conversations: ReadonlyMap<string, readonly ConversationMessage[]>,
  links: ReadonlyMap<string, Pick<AgentLink, 'from' | 'to' | 'messages'>> | undefined,
  textTypes: ReadonlySet<string>,
): { increased: string[]; next: UnreadState } {
  const increased = new Set<string>()
  const convLens = new Map<string, number>()
  const convLast = new Map<string, string>()
  const convLastTs = new Map<string, number>()
  const prevKeys = prev.linkKeys ?? new Set<string>()
  for (const [id, msgs] of conversations) {
    convLens.set(id, msgs.length)
    if (msgs.length > 0) { convLast.set(id, msgs[msgs.length - 1].id); convLastTs.set(id, msgs[msgs.length - 1].timestamp ?? 0) }
    const start = firstUnseenIndex(msgs, prev.convLast?.get(id), prev.convLens.get(id), prev.convLastTs?.get(id))
    for (let i = start; i < msgs.length; i++) {
      const m = msgs[i]
      if (!textTypes.has(m.type)) continue
      if (COMM_MESSAGE_TYPES.has(m.type) && commDedupeKeys(m).some(k => prevKeys.has(`${id}|${k}`))) continue
      increased.add(id)
      break
    }
  }
  const linkKeys = new Set<string>()
  const linkSeen = new Set<string>()
  if (links) {
    const convKeys = new Map<string, Set<string>>()
    const keysOf = (id: string) => {
      let set = convKeys.get(id)
      if (!set) {
        set = new Set()
        for (const m of conversations.get(id) ?? []) {
          if (COMM_MESSAGE_TYPES.has(m.type)) for (const k of commDedupeKeys(m)) set.add(k)
        }
        convKeys.set(id, set)
      }
      return set
    }
    for (const link of links.values()) {
      for (const m of link.messages) {
        linkSeen.add(m.id)
        if (prev.linkSeen.has(m.id) || !textTypes.has(m.type)) continue
        const ck = commDedupeKeys(m)
        const ends = [...new Set([m.from ?? link.from, m.to ?? link.to])].filter((id): id is string => !!id)
        // A copy of a message already held by either endpoint's conversation is not new.
        if (ends.some(id => ck.some(k => keysOf(id).has(k)))) continue
        for (const id of ends) { increased.add(id); linkKeys.add(`${id}|${ck[0]}`) }
      }
    }
  }
  return { increased: [...increased], next: { convLens, convLast, convLastTs, linkSeen, linkKeys: new Set([...prevKeys, ...linkKeys]) } }
}
