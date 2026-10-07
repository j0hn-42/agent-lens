/**
 * Pure helpers for teammate / inter-agent communication (#42).
 *
 * Turns SendMessage / Agent tool uses and <teammate-message> / <task-notification>
 * user-turn notifications into `agent_link` and `message_sent` payloads.
 * Everything here is untrusted input: strings are stripped of control characters
 * and capped, and nothing throws on malformed shapes. No vscode / fs dependencies.
 */
import type { AgentLinkKind, AgentLinkPayload, MessageSentPayload } from './protocol'
import {
  TEAM_MESSAGE_MAX, TEAM_NAME_MAX, TEAM_LINK_ID_MAX,
  TEAM_NOTIFICATION_SCAN_MAX, TEAM_NOTIFICATIONS_PER_TURN_MAX,
  TEAM_DEDUPE_WINDOW_MS, TEAM_DEDUPE_MAX_ENTRIES,
} from './constants'

// C0 controls except \t \n, DEL + C1, zero-width/bidi marks, line/paragraph separators
const INVISIBLE_RANGES: Array<[number, number]> = [[0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]]
const UNSAFE_CHARS = new RegExp(
  '[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f' +
    INVISIBLE_RANGES.map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']',
  'g',
)

/** Cut at `max` UTF-16 units without leaving a dangling high surrogate. */
function capText(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** Strip control characters and cap the length of untrusted free text (newlines/tabs kept). */
export function sanitizeMessageContent(value: unknown, max = TEAM_MESSAGE_MAX): string {
  if (typeof value !== 'string') return ''
  return capText(value.replace(UNSAFE_CHARS, ''), max).trim()
}

/** Sanitize an agent name: single line, no controls, capped. Returns null when nothing is left. */
export function sanitizeAgentName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = capText(value.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim(), TEAM_NAME_MAX).trim()
  return name || null
}

/** Stable id of the communication edge from -> to. */
export function buildLinkId(kind: AgentLinkKind, from: string, to: string): string {
  return capText(`${kind}:${from}>${to}`, TEAM_LINK_ID_MAX)
}

/** Lower-case, whitespace-collapsed, bounded form of a message used to compare copies of it. */
export function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500)
}

/**
 * One message reaches us through several channels (the sender's SendMessage tool_use, the
 * recipient's <teammate-message> turn, the inbox file). The same normalized text on the same
 * link inside the window is ONE message. Memory is bounded (oldest keys evicted).
 */
export class MessageDeduper {
  private seen = new Map<string, number>()
  constructor(private windowMs = TEAM_DEDUPE_WINDOW_MS, private maxEntries = TEAM_DEDUPE_MAX_ENTRIES) {}

  /** True when the message is new (it is remembered now); false for a duplicate inside the window. */
  accept(linkId: string, content: string, now = Date.now()): boolean {
    const norm = normalizeForDedupe(content)
    if (!norm) return true
    const key = `${linkId}\u0000${norm}`
    const at = this.seen.get(key)
    if (at !== undefined && now - at < this.windowMs) return false
    this.seen.delete(key)
    this.seen.set(key, now)
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined) break
      this.seen.delete(oldest)
    }
    return true
  }

  get size(): number { return this.seen.size }
}

export interface TeamLinkEvents {
  link: Omit<AgentLinkPayload, 'sessionId'>
  message?: Omit<MessageSentPayload, 'sessionId'>
}

function messageText(input: Record<string, unknown>): string {
  const raw = input.message ?? input.content ?? input.summary
  if (typeof raw === 'string') return sanitizeMessageContent(raw)
  if (raw && typeof raw === 'object') {
    try { return sanitizeMessageContent(JSON.stringify(raw)) } catch { return '' }
  }
  return ''
}

/**
 * Link/message events implied by a tool_use.
 * - SendMessage with a recipient (`to` or `recipient`): teammate link + message_sent.
 *   Broadcasts without a recipient are ignored (no edge to draw).
 * - Agent / Task: spawn link parent -> child (teammate link when the call names the
 *   agent or a team, i.e. the child stays addressable by SendMessage).
 * - TeamCreate has no recipient and yields nothing.
 * `childName` is the resolved display name of the spawned subagent (Agent/Task only).
 */
export function extractToolUseLinks(
  toolName: string,
  input: unknown,
  from: string,
  toolUseId?: string,
  childName?: string,
): TeamLinkEvents | null {
  if (!input || typeof input !== 'object') return null
  const rec = input as Record<string, unknown>
  const sender = sanitizeAgentName(from)
  if (!sender) return null

  if (toolName === 'SendMessage') {
    const to = sanitizeAgentName(rec.to ?? rec.recipient)
    if (!to || to === '*') return null
    const linkId = buildLinkId('teammate', sender, to)
    const content = messageText(rec)
    // No usable text: keep the edge, but there is no message to show
    if (!content) return { link: { from: sender, to, kind: 'teammate', linkId } }
    return {
      link: { from: sender, to, kind: 'teammate', linkId },
      message: {
        from: sender, to, linkId, content,
        ...(toolUseId ? { toolUseId: sanitizeMessageContent(toolUseId, TEAM_NAME_MAX * 2) } : {}),
      },
    }
  }

  if (toolName === 'Agent' || toolName === 'Task') {
    const to = sanitizeAgentName(childName)
    if (!to) return null
    const named = typeof rec.name === 'string' || typeof rec.team_name === 'string'
    const kind: AgentLinkKind = named ? 'teammate' : 'spawn'
    return { link: { from: sender, to, kind, linkId: buildLinkId(kind, sender, to) } }
  }

  return null
}

export interface IncomingNotification {
  from: string
  content: string
  kind: 'teammate-message' | 'task-notification'
}

/** True when the (trimmed) text starts with a teammate/task notification tag. */
export function isTeamNotification(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('<teammate-message') || t.startsWith('<task-notification')
}

function tagContent(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m ? m[1] : ''
}

/**
 * Extract incoming messages from a user turn:
 *   <teammate-message teammate_id="researcher" summary="...">body</teammate-message>
 *   <task-notification><task-id>..</task-id><status>..</status><summary>..</summary><result>..</result></task-notification>
 * The scanned text and the number of results are bounded. Returns [] for ordinary text.
 */
export function parseTeamNotifications(text: string): IncomingNotification[] {
  if (typeof text !== 'string' || !text.includes('<')) return []
  const scan = text.length > TEAM_NOTIFICATION_SCAN_MAX ? text.slice(0, TEAM_NOTIFICATION_SCAN_MAX) : text
  const out: IncomingNotification[] = []

  const teammateRe = /<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g
  const taskRe = /<task-notification>([\s\S]*?)<\/task-notification>/g
  let m: RegExpExecArray | null
  while ((m = teammateRe.exec(scan)) && out.length < TEAM_NOTIFICATIONS_PER_TURN_MAX) {
    const id = /\bteammate_id="([^"]*)"/.exec(m[1])
    const from = sanitizeAgentName(id?.[1])
    if (!from) continue
    out.push({ from, content: sanitizeMessageContent(m[2]), kind: 'teammate-message' })
  }
  while ((m = taskRe.exec(scan)) && out.length < TEAM_NOTIFICATIONS_PER_TURN_MAX) {
    const id = sanitizeAgentName(tagContent(m[1], 'task-id'))
    if (!id) continue
    const status = sanitizeAgentName(tagContent(m[1], 'status'))
    const summary = sanitizeMessageContent(tagContent(m[1], 'summary'))
    const result = sanitizeMessageContent(tagContent(m[1], 'result'))
    const content = sanitizeMessageContent([status ? `[${status}]` : '', summary, result].filter(Boolean).join('\n'))
    out.push({ from: sanitizeAgentName(`task-${id}`) as string, content, kind: 'task-notification' })
  }
  return out
}
