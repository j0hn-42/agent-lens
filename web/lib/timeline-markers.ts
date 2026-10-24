import type { TimelineEvent } from './agent-types'
import type { ConversationMessage } from '../hooks/simulation/types'
import { MAX_CONVERSATION_MESSAGES, MAX_EVENT_LOG } from '../hooks/simulation/types'

/** Max scrubber markers kept (oldest are dropped and counted in `lost`), same bound as the event log */
const MAX_MARKERS = MAX_EVENT_LOG

export interface MarkerResult {
  /** Markers sorted by time; a new array whenever something changed */
  events: TimelineEvent[]
  /** Markers that exist (or existed) but are not in `events`: dropped by the conversation cap before they were seen, or by MAX_MARKERS */
  lost: number
}

interface AgentSeen {
  /** id of the last message turned into a marker */
  lastId: string
  /** Messages ever appended for this agent as of the last update: dropped + kept */
  total: number
  /** Messages cut by the conversation cap before they could become markers */
  lost: number
}

/**
 * Incremental scrubber markers. Each agent is followed by the id of the last message seen, not by the length of
 * its history: appendConversation caps a conversation, so its length stops moving while new messages keep coming.
 * An agent whose history shrank, or whose last seen message is gone while the window is not full, is a
 * cleared or replaced one: its markers are dropped. Messages that were cut before they could be seen are
 * counted in `lost` (total ever appended minus markers made), so the UI can say so.
 */
export function createMarkerTracker() {
  const seen = new Map<string, AgentSeen>()
  let events: TimelineEvent[] = []
  /** Markers dropped by MAX_MARKERS */
  let capLost = 0
  let idCounter = 0
  let result: MarkerResult = { events, lost: 0 }

  function update(
    conversations: ReadonlyMap<string, ConversationMessage[]>,
    droppedMessages: ReadonlyMap<string, number> = new Map(),
  ): MarkerResult {
    let changed = false
    const removed = new Set<string>()
    const fresh: TimelineEvent[] = []

    for (const agentId of [...seen.keys()]) {
      if (!conversations.has(agentId)) { removed.add(agentId); seen.delete(agentId) }
    }

    for (const [agentId, msgs] of conversations) {
      const prev = seen.get(agentId)
      const dropped = droppedMessages.get(agentId) ?? 0
      const total = dropped + msgs.length
      if (msgs.length === 0) {
        if (prev) { removed.add(agentId); seen.delete(agentId) }
        continue
      }
      const lastMsg = msgs[msgs.length - 1]
      if (prev && prev.lastId === lastMsg.id && prev.total === total) continue

      let start = 0
      let base = prev
      if (prev) {
        const k = findLastIndex(msgs, prev.lastId)
        if (k >= 0 && total >= prev.total) {
          start = k + 1
        } else if (total < prev.total || msgs.length < MAX_CONVERSATION_MESSAGES) {
          // cleared or replaced: the window is not full, so the last seen message cannot have slid out of it
          removed.add(agentId)
          base = undefined
        }
      }
      const already = base ? base.total : 0
      for (let i = start; i < msgs.length; i++) {
        const msg = msgs[i]
        fresh.push({
          id: `event-${idCounter++}`,
          type: msg.type === 'tool_call' ? 'tool_call' : msg.type === 'tool_result' ? 'tool_result' : 'message',
          label: msg.content.slice(0, 20),
          timestamp: msg.timestamp,
          nodeId: agentId,
        })
      }
      const lostNow = Math.max(0, total - already - (msgs.length - start))
      seen.set(agentId, { lastId: lastMsg.id, total, lost: (base ? base.lost : 0) + lostNow })
      changed = true
    }

    if (removed.size > 0) {
      const kept = events.filter(e => !removed.has(e.nodeId ?? ''))
      if (seen.size === 0) capLost = 0
      events = kept
      changed = true
    }
    if (fresh.length > 0) {
      fresh.sort((a, b) => a.timestamp - b.timestamp)
      events = mergeSorted(events, fresh)
    }
    if (events.length > MAX_MARKERS) {
      capLost += events.length - MAX_MARKERS
      events = events.slice(events.length - MAX_MARKERS)
      changed = true
    }
    if (changed) {
      let lost = capLost
      for (const a of seen.values()) lost += a.lost
      result = { events, lost }
    }
    return result
  }

  return { update }
}

function findLastIndex(msgs: ConversationMessage[], id: string): number {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].id === id) return i
  return -1
}

/** Stable merge of two time-sorted lists into a new array (equal timestamps keep `a` before `b`) */
function mergeSorted(a: TimelineEvent[], b: TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = new Array(a.length + b.length)
  let i = 0, j = 0, k = 0
  while (i < a.length && j < b.length) out[k++] = a[i].timestamp <= b[j].timestamp ? a[i++] : b[j++]
  while (i < a.length) out[k++] = a[i++]
  while (j < b.length) out[k++] = b[j++]
  return out
}
