import type { Agent } from '../../lib/agent-types'
import type { MutableEventState } from './process-event'
import { edgeId } from './types'

/**
 * Why a parent -> child edge is not proven. An edge is only presented as fact when the events agree;
 * every other case is drawn dashed ("unverified") rather than guessed.
 */
export type UnverifiedReason =
  /** the child started with no tool_use_id: a name alone is not a proof */
  | 'no-tool-use-id'
  /** the declared parent is unknown, the child was hung on the session's main agent instead */
  | 'parent-fallback'
  /** no earlier call (dispatch or tool call) by the parent carries this tool_use_id */
  | 'no-call'
  /** a call with this tool_use_id was made by another agent than the declared parent */
  | 'parent-mismatch'
  /** a dispatch with this tool_use_id names another child */
  | 'child-mismatch'
  /** a later return names another parent or child for this tool_use_id */
  | 'return-mismatch'
  /** a later dispatch names another parent or child for this tool_use_id */
  | 'dispatch-mismatch'

export type EdgeVerdict = { verified: true } | { verified: false; reason: UnverifiedReason }

export interface SpawnClaim {
  sessionId: string
  parentKey: string
  childKey: string
  toolUseId: string | undefined
  /** False when the parent was not found and the main agent was used instead */
  parentResolved: boolean
}

/**
 * Judge a freshly spawned child against what the stream already said. Chronology is the order of
 * arrival: the call must already be in the state BEFORE the start, so a late or missing dispatch never
 * produces a verified edge. Scope is the session: a tool_use_id of another session proves nothing.
 */
export function judgeSpawn(state: MutableEventState, claim: SpawnClaim, currentTime: number): EdgeVerdict {
  const { sessionId, parentKey, childKey, toolUseId } = claim
  if (!claim.parentResolved) return { verified: false, reason: 'parent-fallback' }
  if (!toolUseId) return { verified: false, reason: 'no-tool-use-id' }

  let proven = false
  let parentConflict = false
  let childConflict = false

  for (const link of state.links.values()) {
    if (link.sessionId !== sessionId) continue
    for (const m of link.messages) {
      if (m.type !== 'dispatch' || m.toolUseId !== toolUseId) continue
      if (m.from !== parentKey) parentConflict = true
      else if (m.to !== childKey) childConflict = true
      else if (m.timestamp <= currentTime) proven = true
    }
  }
  for (const tc of state.toolCalls.values()) {
    if (tc.toolUseId !== toolUseId) continue
    const owner = state.agents.get(tc.agentId)
    if (owner && owner.sessionId !== sessionId) continue
    if (tc.agentId !== parentKey) parentConflict = true
    else if (tc.startTime <= currentTime) proven = true
  }

  if (parentConflict) return { verified: false, reason: 'parent-mismatch' }
  if (childConflict) return { verified: false, reason: 'child-mismatch' }
  if (!proven) return { verified: false, reason: 'no-call' }
  return { verified: true }
}

/** Does the child name used by a later event designate this agent (its local id, or its disambiguated form)? */
export function namesAgent(agent: Pick<Agent, 'localId'>, rawChild: string, toolUseId: string): boolean {
  return rawChild === agent.localId || agent.localId === `${rawChild}@${toolUseId}`
}

/** Mark the parent -> child edge of `agentKey` as unverified; a first reason is kept. Idempotent. */
export function demoteEdge(state: MutableEventState, agentKey: string, reason: UnverifiedReason): void {
  const agent = state.agents.get(agentKey)
  if (!agent?.parentId) return
  const id = edgeId(agent.parentId, agentKey)
  const i = state.edges.findIndex(e => e.id === id)
  if (i === -1 || state.edges[i].verified === false) return
  state.edges[i] = { ...state.edges[i], verified: false, unverifiedReason: reason }
}
