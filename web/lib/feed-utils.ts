// Pure helpers shared by the message feed, transcript and tool content views.
// Kept free of React / path-alias imports so they can be unit tested with node:test.

// State labels live in state-labels.ts (single source of truth); re-exported for feed consumers.
export { STATE_LABELS, getStateLabel as stateLabel } from './state-labels'

import type { ConversationMessage, AgentLink } from '../hooks/simulation/types'
import type { TeamSummary } from './agent-types'
import { formatDroppedMessages } from './chrome-utils'

/** Single empty-state wording used by every message list. */
export const EMPTY_MESSAGES = 'No messages yet'
export const EMPTY_SEARCH = 'No matching messages'

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

// ─── Agent-to-agent communication (dispatch / return / teammate messages) ────

/** Message types shown as plain conversation text. */
export const TEXT_MESSAGE_TYPES: ReadonlySet<string> = new Set(['assistant', 'user', 'thinking'])
/** Message types that describe a communication between two agents. */
export const COMM_MESSAGE_TYPES: ReadonlySet<string> = new Set(['dispatch', 'return', 'message'])
/** Everything the message feed lists. */
export const FEED_MESSAGE_TYPES: ReadonlySet<string> = new Set([...TEXT_MESSAGE_TYPES, ...COMM_MESSAGE_TYPES])

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
  teams?: ReadonlyMap<string, Pick<TeamSummary, 'members'>>,
): string | undefined {
  if (!agent) return undefined
  const own = safeHexColor(agent.teamColor)
  if (own) return own
  if (!agent.teamName || !teams) return undefined
  const member = teams.get(agent.teamName)?.members.find(m => m.name === agent.name)
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

function commDedupeKey(m: ConversationMessage): string {
  return `${m.type}|${m.from ?? ''}|${m.to ?? ''}|${m.toolUseId ?? m.timestamp}`
}

/**
 * Every feed message of every agent (finished agents included), merged with the messages carried by
 * links, deduplicated and sorted by time. `agentId` is the conversation owner (the sender for
 * messages that only exist on a link).
 */
export function buildFeedMessages(
  conversations: ReadonlyMap<string, readonly ConversationMessage[]>,
  links?: ReadonlyMap<string, Pick<AgentLink, 'from' | 'messages'>>,
): FeedMessage[] {
  const out: FeedMessage[] = []
  const seenIds = new Set<string>()
  const seenComm = new Set<string>()
  const push = (m: ConversationMessage, agentId: string) => {
    if (!FEED_MESSAGE_TYPES.has(m.type) || seenIds.has(m.id)) return
    if (COMM_MESSAGE_TYPES.has(m.type)) {
      const k = commDedupeKey(m)
      if (seenComm.has(k)) return
      seenComm.add(k)
    }
    seenIds.add(m.id)
    out.push({ ...m, agentId })
  }
  for (const [agentId, msgs] of conversations) for (const m of msgs) push(m, agentId)
  if (links) for (const link of links.values()) for (const m of link.messages) push(m, m.from ?? link.from)
  return out.sort((a, b) => a.timestamp - b.timestamp)
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
