/**
 * "Why this tool?" and the causal chain of a failure (issue #231). Pure: no React, no clock.
 *
 * Proof rules, nothing else is shown:
 * - the reasoning of a call is the thinking observed in the agent's own conversation right before the
 *   `tool_call` carrying the same tool_use_id (a batch of parallel calls shares what precedes the batch);
 *   anything separated from it by a result, an answer or a prompt is not attributed to the call;
 * - without a tool_use_id, with a call absent from the (bounded) history, or when older messages were
 *   dropped, the answer is "unknown", never "none";
 * - a hop up the chain needs the dispatch message of the parent (same tool_use_id, from the declared
 *   parent) AND a verified parent-child edge; otherwise the chain stops with an explicit break;
 * - the prompt is the latest user message observed before the dispatch (or the failing call) in the root
 *   agent's conversation; it is an ordering fact, not a claim that the prompt "caused" the failure.
 */
import type { Agent, Edge } from './agent-types'
import type { ConversationMessage } from '../hooks/simulation/types'

/** Text the transcript parser emits for a thinking block whose content was redacted by the runtime. */
export const REDACTED_PLACEHOLDER = 'Thinking...'

export interface Thought { text: string; redacted: boolean }

export type UnknownReason = 'no-tool-use-id' | 'call-not-in-history' | 'history-truncated'

export type ReasoningResult =
  | { kind: 'found'; thoughts: Thought[]; incomplete: boolean }
  | { kind: 'none' }
  | { kind: 'unknown'; reason: UnknownReason }

type Conversation = readonly ConversationMessage[] | undefined

function indexOfCall(messages: readonly ConversationMessage[], toolUseId: string): number {
  return messages.findIndex(m => m.type === 'tool_call' && m.toolUseId === toolUseId)
}

/** Thinking observed just before the call `toolUseId`; `dropped` = older messages lost to the history cap. */
export function reasoningBefore(messages: Conversation, toolUseId: string | undefined, dropped: number): ReasoningResult {
  if (!toolUseId) return { kind: 'unknown', reason: 'no-tool-use-id' }
  if (!messages) return { kind: 'unknown', reason: 'call-not-in-history' }
  const at = indexOfCall(messages, toolUseId)
  if (at < 0) return { kind: 'unknown', reason: 'call-not-in-history' }
  let i = at - 1
  while (i >= 0 && messages[i].type === 'tool_call') i--
  const thoughts: Thought[] = []
  while (i >= 0 && messages[i].type === 'thinking') {
    const text = messages[i].content
    thoughts.unshift(text === REDACTED_PLACEHOLDER ? { text: '', redacted: true } : { text, redacted: false })
    i--
  }
  const reachedStart = i < 0
  if (thoughts.length === 0) return reachedStart && dropped > 0 ? { kind: 'unknown', reason: 'history-truncated' } : { kind: 'none' }
  return { kind: 'found', thoughts, incomplete: reachedStart && dropped > 0 }
}

export type BreakReason = 'dispatch-not-observed' | 'link-unverified' | 'parent-unknown'

export type ChainStep =
  | { kind: 'failure'; text: string }
  | { kind: 'reasoning'; agentId: string; result: ReasoningResult }
  | { kind: 'dispatch'; parentId: string; childId: string; prompt: string; reasoning: ReasoningResult }
  | { kind: 'break'; reason: BreakReason; agentId: string }
  | { kind: 'prompt'; agentId: string; text: string }
  | { kind: 'prompt-unknown'; agentId: string; reason: UnknownReason | 'none-observed' }

export interface ChainInput {
  agentId: string
  toolUseId: string | undefined
  errorText: string
  agents: ReadonlyMap<string, Pick<Agent, 'id' | 'parentId' | 'toolUseId'>>
  conversations: ReadonlyMap<string, readonly ConversationMessage[]>
  droppedMessages: ReadonlyMap<string, number>
  edges: readonly Pick<Edge, 'type' | 'from' | 'to' | 'verified'>[]
}

/** Maximum hops followed; a deeper tree stops with a break rather than looping. */
const MAX_HOPS = 8

function promptBefore(input: ChainInput, agentId: string, anchorToolUseId: string | undefined): ChainStep {
  const msgs = input.conversations.get(agentId)
  if (!anchorToolUseId) return { kind: 'prompt-unknown', agentId, reason: 'no-tool-use-id' }
  if (!msgs) return { kind: 'prompt-unknown', agentId, reason: 'call-not-in-history' }
  let at = indexOfCall(msgs, anchorToolUseId)
  if (at < 0) at = msgs.findIndex(m => m.type === 'dispatch' && m.toolUseId === anchorToolUseId)
  if (at < 0) return { kind: 'prompt-unknown', agentId, reason: 'call-not-in-history' }
  for (let i = at - 1; i >= 0; i--) {
    if (msgs[i].type === 'user') return { kind: 'prompt', agentId, text: msgs[i].content }
  }
  return { kind: 'prompt-unknown', agentId, reason: (input.droppedMessages.get(agentId) ?? 0) > 0 ? 'history-truncated' : 'none-observed' }
}

/** Failure first, then each proven hop up to the prompt (or an explicit break / unknown). */
export function causalChain(input: ChainInput): ChainStep[] {
  const { conversations, droppedMessages } = input
  const steps: ChainStep[] = [{ kind: 'failure', text: input.errorText }]
  steps.push({
    kind: 'reasoning', agentId: input.agentId,
    result: reasoningBefore(conversations.get(input.agentId), input.toolUseId, droppedMessages.get(input.agentId) ?? 0),
  })

  let current = input.agentId
  let anchor = input.toolUseId
  const seen = new Set<string>([current])
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const agent = input.agents.get(current)
    if (!agent) { steps.push({ kind: 'break', reason: 'parent-unknown', agentId: current }); return steps }
    const parentId = agent.parentId
    if (!parentId) { steps.push(promptBefore(input, current, anchor)); return steps }
    const dispatch = agent.toolUseId
      ? conversations.get(current)?.find(m => m.type === 'dispatch' && m.toolUseId === agent.toolUseId && m.from === parentId)
      : undefined
    if (!dispatch) { steps.push({ kind: 'break', reason: 'dispatch-not-observed', agentId: current }); return steps }
    const edge = input.edges.find(e => e.type === 'parent-child' && e.from === parentId && e.to === current)
    if (edge?.verified !== true) { steps.push({ kind: 'break', reason: 'link-unverified', agentId: current }); return steps }
    if (seen.has(parentId) || !input.agents.has(parentId)) { steps.push({ kind: 'break', reason: 'parent-unknown', agentId: current }); return steps }
    seen.add(parentId)
    steps.push({
      kind: 'dispatch', parentId, childId: current, prompt: dispatch.content,
      reasoning: reasoningBefore(conversations.get(parentId), agent.toolUseId, droppedMessages.get(parentId) ?? 0),
    })
    current = parentId
    anchor = agent.toolUseId
  }
  steps.push({ kind: 'break', reason: 'parent-unknown', agentId: current })
  return steps
}
