import type { TimelineEvent } from './agent-types'
import type { ConversationMessage } from '../hooks/simulation/types'
import { MAX_EVENT_LOG } from '../hooks/simulation/types'

/** Max scrubber markers kept (oldest are dropped and counted in `lost`), same bound as the event log */
const MAX_MARKERS = MAX_EVENT_LOG

export interface MarkerResult {
  /** Markers sorted by time; a new array whenever something changed */
  events: TimelineEvent[]
  /** Markers that exist (or existed) but are not in `events`: dropped by the conversation cap before they were seen, or by MAX_MARKERS (these were seen, then dropped) */
  lost: number
}

interface AgentSeen {
  /** Fingerprint of the last message turned into a marker (survives a replay, which gives new ids) */
  lastSig: string
  /** Messages ever appended for this agent as of the last update: dropped + kept */
  total: number
  /** Messages cut by the conversation cap before they could become markers */
  lost: number
}

/**
 * Incremental scrubber markers. Each agent is followed by an absolute position (messages dropped by the cap +
 * index in the window), not by the length of its history: appendConversation caps a conversation, so its length
 * stops moving while new messages keep coming. Ids are not used: a replay (seek, resume live) rebuilds the same
 * conversation with new ids. The position is stable across a replay; a fingerprint of the last seen message
 * (type, time, content) detects another conversation. An agent whose total shrank, or whose message at the last
 * seen position differs, is a cleared or replaced one: its markers are dropped. Messages that were cut before they could be seen are
 * counted in `lost` (total ever appended minus markers made), so the UI can say so.
 */
export function createMarkerTracker() {
  const seen = new Map<string, AgentSeen>()
  let events: TimelineEvent[] = []
  /** Markers dropped by MAX_MARKERS, per agent: an agent that is erased or replaced takes its own with it (#613) */
  const capLost = new Map<string, number>()
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
      const lastSig = signature(lastMsg)
      if (prev && prev.total === total && prev.lastSig === lastSig) continue

      let start = 0
      let base = prev
      if (prev) {
        // index in the window of the last message seen, if it is still readable
        const k = prev.total - 1 - dropped
        const sameConversation = total >= prev.total && (k < 0 || (k < msgs.length && signature(msgs[k]) === prev.lastSig))
        if (sameConversation) {
          start = Math.max(0, k + 1)
        } else {
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
      seen.set(agentId, { lastSig, total, lost: (base ? base.lost : 0) + lostNow })
      changed = true
    }

    if (removed.size > 0) {
      const kept = events.filter(e => !removed.has(e.nodeId ?? ''))
      for (const id of removed) capLost.delete(id)
      events = kept
      changed = true
    }
    if (fresh.length > 0) {
      fresh.sort((a, b) => a.timestamp - b.timestamp)
      events = mergeSorted(events, fresh)
    }
    if (events.length > MAX_MARKERS) {
      for (let i = 0; i < events.length - MAX_MARKERS; i++) {
        const id = events[i].nodeId ?? ''
        capLost.set(id, (capLost.get(id) ?? 0) + 1)
      }
      events = events.slice(events.length - MAX_MARKERS)
      changed = true
    }
    if (changed) {
      let lost = 0
      for (const n of capLost.values()) lost += n
      for (const a of seen.values()) lost += a.lost
      result = { events, lost }
    }
    return result
  }

  return { update }
}

function signature(msg: ConversationMessage): string {
  return `${msg.type}|${msg.timestamp}|${msg.content}`
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
