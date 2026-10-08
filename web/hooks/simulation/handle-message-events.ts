import type { ContextBreakdown } from '../../lib/agent-types'
import type { ConversationMessage } from './types'
import { agentKeyOf, cappedString, DEFAULT_SESSION_ID, LABEL_LEN_NAME, LABEL_LEN_TASK, LABEL_LEN_BUBBLE, MAX_BUBBLES } from './types'
import type { MutableEventState } from './process-event'
import { idString } from './agent-keys'
import { appendBoundedConversation } from './archive'
import { readTokenCost, readTokenSource } from '../../lib/usage'
import { resolveUsageTarget, addUnattributed } from '../../lib/attribution'

export function handleMessage(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const agentName = agentKeyOf(sessionId, idString(payload.agent))
  const content = cappedString(payload.content)
  const role = typeof payload.role === 'string' ? payload.role : undefined

  // Map role to conversation message type
  const msgType: ConversationMessage['type'] =
    role === 'user' ? 'user' :
    role === 'thinking' ? 'thinking' :
    'assistant'

  // Rename main agent to the first user message (more recognizable than "orchestrator")
  if (role === 'user') {
    const msgAgentForName = state.agents.get(agentName)
    // Only rename once: while the display name is still the local id
    if (msgAgentForName && msgAgentForName.isMain && msgAgentForName.displayName === msgAgentForName.localId) {
      const shortName = content.slice(0, LABEL_LEN_NAME).replace(/\n/g, ' ').trim()
      const displayName = shortName || msgAgentForName.localId
      state.agents.set(agentName, { ...msgAgentForName, name: displayName, displayName, task: content.slice(0, LABEL_LEN_TASK) })
    }
  }

  // Update agent state and push message bubble to queue
  const msgAgent = state.agents.get(agentName)
  if (msgAgent) {
    const bubbleRole: 'user' | 'thinking' | 'assistant' = role === 'user' ? 'user' : role === 'thinking' ? 'thinking' : 'assistant'
    const updates: Partial<typeof msgAgent> = {}

    {
      // Truncate thinking for graph bubbles (full text in message feed panel)
      const bubbleText = bubbleRole === 'thinking' ? content.slice(0, LABEL_LEN_BUBBLE) + (content.length > LABEL_LEN_BUBBLE ? '...' : '') : content
      // Dedup: skip if last bubble has the same text (dual event source race)
      const lastBubble = msgAgent.messageBubbles[msgAgent.messageBubbles.length - 1]
      if (!lastBubble || lastBubble.text !== bubbleText) {
        const newBubbles = [...msgAgent.messageBubbles, { text: bubbleText, time: currentTime, role: bubbleRole }]
        updates.messageBubbles = newBubbles.length > MAX_BUBBLES ? newBubbles.slice(-MAX_BUBBLES) : newBubbles
      }
    }

    if (msgAgent.state !== 'complete' && msgAgent.state !== 'tool_calling') {
      if (role === 'user' || role === 'thinking' || role === 'assistant') {
        updates.state = 'thinking'
      }
    }
    if (Object.keys(updates).length > 0) {
      state.agents.set(agentName, { ...msgAgent, ...updates })
    }
  }

  appendBoundedConversation(state, agentName, { type: msgType, content, timestamp: currentTime })
}

export function handleContextUpdate(
  payload: Record<string, unknown>,
  state: MutableEventState,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const agentName = agentKeyOf(sessionId, idString(payload.agent))
  // A context_update without a usable figure must not reset the counter to 0
  const tokens = readTokenCost(payload.tokens)
  const raw = payload.breakdown
  const breakdown = (raw && typeof raw === 'object' && 'systemPrompt' in raw) ? raw as ContextBreakdown : undefined
  // Optional override from runtimes that report an authoritative context window
  // (e.g. Codex's event_msg.token_count.info.model_context_window).
  const tokensMaxOverride = typeof payload.tokensMax === 'number' && payload.tokensMax > 0
    ? payload.tokensMax
    : undefined
  const agent = state.agents.get(agentName)
  // Context size is an absolute reading: it belongs to one agent or to the remainder, never to a guess (#61)
  const target = resolveUsageTarget(state.agents, sessionId, idString(payload.agent))
  if (target.kind !== 'attributed') {
    // A name that became ambiguous keeps its first holder's last attributed reading; adding this one on top would
    // count the same context twice, and which instance it belongs to is unknown, so state/max/breakdown stay put.
    if (target.kind === 'ambiguous' && agent && agent.tokensUsed > 0) return
    addUnattributed(state.unattributed, sessionId, target.key, target.kind, tokens ?? 0, 'set')
    return
  }
  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      // An absolute figure replaces the running sum: gaps counted before it no longer apply
      ...(tokens !== null
        ? { tokensUsed: tokens, tokenStatus: 'available' as const, tokenGaps: 0, tokensEstimated: readTokenSource(payload.tokenSource) === 'estimated' }
        : {}),
      tokensMax: tokensMaxOverride ?? agent.tokensMax,
      contextBreakdown: breakdown || agent.contextBreakdown,
      state: agent.state === 'complete' ? 'complete' : 'thinking'
    })
  }
}
