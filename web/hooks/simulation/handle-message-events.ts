import type { ContextBreakdown } from '../../lib/agent-types'
import type { ConversationMessage } from './types'
import { appendConversation, asNumber, agentKeyOf, cappedString, DEFAULT_SESSION_ID, LABEL_LEN_NAME, LABEL_LEN_TASK, LABEL_LEN_BUBBLE, MAX_BUBBLES } from './types'
import type { MutableEventState } from './process-event'
import { idString } from './agent-keys'

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

  appendConversation(state.conversations, agentName, { type: msgType, content, timestamp: currentTime }, state.droppedMessages)
}

export function handleContextUpdate(
  payload: Record<string, unknown>,
  state: MutableEventState,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const agentName = agentKeyOf(sessionId, idString(payload.agent))
  const tokens = asNumber(payload.tokens)
  const raw = payload.breakdown
  const breakdown = (raw && typeof raw === 'object' && 'systemPrompt' in raw) ? raw as ContextBreakdown : undefined
  // Optional override from runtimes that report an authoritative context window
  // (e.g. Codex's event_msg.token_count.info.model_context_window).
  const tokensMaxOverride = typeof payload.tokensMax === 'number' && payload.tokensMax > 0
    ? payload.tokensMax
    : undefined
  const agent = state.agents.get(agentName)
  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      tokensUsed: tokens,
      tokensMax: tokensMaxOverride ?? agent.tokensMax,
      contextBreakdown: breakdown || agent.contextBreakdown,
      state: agent.state === 'complete' ? 'complete' : 'thinking'
    })
  }
}
