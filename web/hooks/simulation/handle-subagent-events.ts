import { COLORS } from '../../lib/colors'
import type { MutableEventState } from './process-event'
import { edgeId, asBoolean, agentKeyOf, cappedString, cutCharsOf, cutField, DEFAULT_SESSION_ID, LABEL_LEN_SHORT } from './types'
import { idString, resolveChildLocalId, findAgentByToolUseId } from './agent-keys'
import { demoteEdge, namesAgent, type UnverifiedReason } from './edge-validation'
import { addLinkMessage } from './handle-link-events'
import { appendBoundedConversation } from './archive'

function optString(v: unknown): string | undefined {
  const s = cappedString(v)
  return s || undefined
}

/** Agent keys of parent and child for a dispatch/return event, identity following the tool_use_id. */
function resolveParties(
  payload: Record<string, unknown>,
  state: MutableEventState,
  sessionId: string,
): { parentKey: string; childKey: string; toolUseId: string | undefined } {
  const toolUseId = idString(payload.toolUseId) || undefined
  const parentKey = agentKeyOf(sessionId, idString(payload.parent))
  const childKey = agentKeyOf(sessionId, resolveChildLocalId(state.agents, sessionId, idString(payload.child), toolUseId))
  return { parentKey, childKey, toolUseId }
}

/**
 * A dispatch/return that contradicts the agent already started for its tool_use_id demotes that agent's edge.
 * Identity follows the tool_use_id, never the name: a return relayed by the hooks names the child
 * `<type>-<agent id suffix>`, not the transcript's description. Only a dispatch (same source as the
 * start) is also compared on the child name.
 */
function checkAgainstKnownChild(
  payload: Record<string, unknown>, state: MutableEventState, sessionId: string,
  parentKey: string, toolUseId: string | undefined, reason: UnverifiedReason,
): void {
  if (!toolUseId) return
  const known = findAgentByToolUseId(state.agents, sessionId, toolUseId)
  if (!known || !known.parentId) return
  const nameMismatch = reason === 'dispatch-mismatch' && !namesAgent(known, idString(payload.child), toolUseId)
  if (known.parentId !== parentKey || nameMismatch) {
    demoteEdge(state, known.id, reason)
  }
}

export function handleSubagentDispatch(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const { parentKey, childKey, toolUseId } = resolveParties(payload, state, sessionId)
  checkAgainstKnownChild(payload, state, sessionId, parentKey, toolUseId, 'dispatch-mismatch')
  const eid = edgeId(parentKey, childKey)
  const task = cappedString(payload.task)
  const prompt = optString(payload.prompt)
  const cut = cutField(prompt ? cutCharsOf(payload.prompt) : cutCharsOf(payload.task))

  // Full prompt goes into both conversations so it is readable in the transcript/chat
  for (const owner of new Set([parentKey, childKey])) {
    appendBoundedConversation(state, owner, {
      type: 'dispatch', content: prompt || task, timestamp: currentTime,
      from: parentKey, to: childKey, linkId: eid, toolUseId, ...cut,
    })
  }
  addLinkMessage(state, { id: eid, from: parentKey, to: childKey, kind: 'spawn', sessionId }, {
    type: 'dispatch', content: prompt || task, timestamp: currentTime,
    from: parentKey, to: childKey, linkId: eid, toolUseId, ...cut,
  })

  state.particles.push({
    id: `p-disp-${currentTime}-${eid}`,
    edgeId: eid, progress: 0,
    type: 'dispatch', color: COLORS.dispatch,
    size: 6, trailLength: 0.2,
    label: task.slice(0, LABEL_LEN_SHORT),
    detail: {
      prompt,
      subagentType: optString(payload.subagentType),
      model: optString(payload.model),
      toolUseId,
    },
  })
}

export function handleSubagentReturn(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const { parentKey, childKey, toolUseId } = resolveParties(payload, state, sessionId)
  checkAgainstKnownChild(payload, state, sessionId, parentKey, toolUseId, 'return-mismatch')
  const eid = edgeId(parentKey, childKey)
  const summary = cappedString(payload.summary)
  const isError = asBoolean(payload.isError)
  const cut = cutField(cutCharsOf(payload.summary))

  // Full report goes into both conversations (parent receives it, child produced it)
  for (const owner of new Set([parentKey, childKey])) {
    appendBoundedConversation(state, owner, {
      type: 'return', content: summary, timestamp: currentTime,
      from: childKey, to: parentKey, linkId: eid, toolUseId, ...cut,
      ...(isError ? { isError } : {}),
    })
  }
  addLinkMessage(state, { id: eid, from: parentKey, to: childKey, kind: 'spawn', sessionId }, {
    type: 'return', content: summary, timestamp: currentTime,
    from: childKey, to: parentKey, linkId: eid, toolUseId, ...cut,
    ...(isError ? { isError } : {}),
  })

  state.particles.push({
    id: `p-ret-${currentTime}-${eid}`,
    edgeId: eid, progress: 1,
    type: 'return', color: COLORS.return,
    size: 5, trailLength: 0.2,
    label: summary.slice(0, LABEL_LEN_SHORT),
    detail: {
      summary,
      toolUseId,
      isError,
      durationS: typeof payload.durationS === 'number' ? payload.durationS : undefined,
    },
  })
}
