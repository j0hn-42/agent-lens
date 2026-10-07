import { COLORS } from '@/lib/colors'
import type { MutableEventState } from './process-event'
import { appendConversation, edgeId, asString, asBoolean, LABEL_LEN_SHORT } from './types'

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

export function handleSubagentDispatch(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const parentName = asString(payload.parent)
  const childName = asString(payload.child)
  const eid = edgeId(parentName, childName)
  const task = asString(payload.task)
  const prompt = optString(payload.prompt)
  const toolUseId = optString(payload.toolUseId)

  // Full prompt goes into both conversations so it is readable in the transcript/chat
  for (const owner of new Set([parentName, childName])) {
    appendConversation(state.conversations, owner, {
      type: 'dispatch', content: prompt || task, timestamp: currentTime,
      from: parentName, to: childName, linkId: eid, toolUseId,
    })
  }

  state.particles.push({
    id: `p-disp-${currentTime}-${eid}`,
    edgeId: eid, progress: 0,
    type: 'dispatch', color: COLORS.dispatch,
    size: 6, trailLength: 0.2,
    label: task.slice(0, LABEL_LEN_SHORT),
    detail: {
      prompt: optString(payload.prompt),
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
): void {
  const parentName = asString(payload.parent)
  const childName = asString(payload.child)
  const eid = edgeId(parentName, childName)
  const summary = asString(payload.summary)
  const toolUseId = optString(payload.toolUseId)
  const isError = asBoolean(payload.isError)

  // Full report goes into both conversations (parent receives it, child produced it)
  for (const owner of new Set([parentName, childName])) {
    appendConversation(state.conversations, owner, {
      type: 'return', content: summary, timestamp: currentTime,
      from: childName, to: parentName, linkId: eid, toolUseId,
      ...(isError ? { isError } : {}),
    })
  }

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
