import { COLORS } from '../../lib/colors'
import { TOOL_DEDUP_WINDOW_S } from '../../lib/canvas-constants'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { appendConversation, asString, agentKeyOf, cappedString, DEFAULT_SESSION_ID, LABEL_LEN_PARTICLE, LABEL_LEN_TIMELINE } from './types'
import { idString } from './agent-keys'
import { parseMcpTool, formatToolName } from '../../lib/mcp-tool'
import { readToolOutcome } from '../../lib/tool-lifecycle'
import { readTokenCost, readTokenSource, effectiveTokenStatus } from '../../lib/usage'
import type { Agent, ToolCallNode } from '../../lib/agent-types'
import { resolveUsageTarget, addUnattributed } from '../../lib/attribution'

/** Extract file path from tool input data or fall back to first token of args */
function extractFilePath(inputData?: Record<string, unknown>, args?: string): string {
  return asString(inputData?.file_path) || args?.split(' ')[0] || ''
}

/**
 * The call an end belongs to. A running call wins; an expired one only when the tool_use_id proves the
 * match (a late end), since without an id it could belong to anything.
 */
function findCallToClose(toolCalls: Map<string, ToolCallNode>, agentId: string, toolName: string, toolUseId: string | undefined): string | undefined {
  let expired: string | undefined
  for (const [id, tc] of toolCalls) {
    if (tc.agentId !== agentId || tc.toolName !== toolName) continue
    const idMatches = toolUseId === undefined || tc.toolUseId === undefined || tc.toolUseId === toolUseId
    if (idMatches && tc.state === 'running') return id
    if (tc.state === 'expired' && toolUseId !== undefined && tc.toolUseId === toolUseId) expired = id
  }
  return expired
}

/** Token counters after one more figure: a present value adds up, an absent one only widens the gap. */
export function addToken(
  agent: Pick<Agent, 'tokensUsed' | 'tokenStatus' | 'tokenGaps' | 'tokensEstimated'>,
  cost: number | null,
  source: 'reported' | 'estimated',
): Pick<Agent, 'tokensUsed' | 'tokenStatus' | 'tokenGaps' | 'tokensEstimated'> {
  const hasValue = effectiveTokenStatus(agent) !== 'unavailable'
  const gaps = (agent.tokenGaps ?? 0) + (cost === null ? 1 : 0)
  const known = hasValue || cost !== null
  return {
    tokensUsed: agent.tokensUsed + (cost ?? 0),
    tokenGaps: gaps,
    tokenStatus: !known ? 'unavailable' : gaps > 0 ? 'partial' : 'available',
    tokensEstimated: (agent.tokensEstimated === true) || (cost !== null && source === 'estimated'),
  }
}

export function handleToolCallStart(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const agentName = agentKeyOf(sessionId, idString(payload.agent))
  const toolName = idString(payload.tool)
  const args = cappedString(payload.args)
  const inputData = (payload.inputData && typeof payload.inputData === 'object' && !Array.isArray(payload.inputData))
    ? payload.inputData as Record<string, unknown> : undefined
  const toolUseId = idString(payload.toolUseId) || undefined
  const agent = state.agents.get(agentName)

  if (agent) {
    // Dedup: skip if there's already a running tool call for the same agent+tool
    // created within the last 3 seconds (race between Hook Server and Session Watcher).
    // Calls with different tool_use_ids are distinct (parallel Agent calls).
    let isDuplicate = false
    for (const tc of state.toolCalls.values()) {
      const distinctIds = toolUseId !== undefined && tc.toolUseId !== undefined && tc.toolUseId !== toolUseId
      if (!distinctIds && tc.agentId === agentName && tc.toolName === toolName && tc.state === 'running' && (currentTime - tc.startTime) < TOOL_DEDUP_WINDOW_S) {
        isDuplicate = true
        break
      }
    }
    if (isDuplicate) return

    state.agents.set(agentName, {
      ...agent,
      state: 'tool_calling',
      currentTool: toolName,
      toolCalls: agent.toolCalls + 1
    })

    const toolId = `tool-${agentName}-${toolName}-${currentTime}${toolUseId ? `-${toolUseId}` : ''}`

    const pos = ctx.findToolSlot(agent, state.agents, state.toolCalls, currentTime)

    const mcp = parseMcpTool(toolName)

    state.toolCalls.set(toolId, {
      id: toolId, agentId: agentName, toolName,
      ...(mcp ? { mcp } : {}),
      state: 'running',
      args,
      inputData,
      ...(toolUseId ? { toolUseId } : {}),
      x: pos.x,
      y: pos.y,
      startTime: currentTime,
      opacity: 0,
    })

    state.edges.push({ id: `edge-${toolId}`, from: agentName, to: toolId, type: 'tool', opacity: 0 })

    state.particles.push({
      id: `p-tc-${currentTime}-${toolId}`,
      edgeId: `edge-${toolId}`, progress: 0,
      type: 'tool_call', color: mcp ? COLORS.mcp : COLORS.tool,
      size: 4, trailLength: 0.15,
      ...(mcp ? { mcp: true } : {}),
      label: `${formatToolName(toolName)} ${args}`.slice(0, LABEL_LEN_PARTICLE),
    })

    // Timeline block
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      pushTimelineBlock(entry, currentTime, { type: 'tool_call', label: `${formatToolName(toolName)}: ${args}`.slice(0, LABEL_LEN_TIMELINE), color: mcp ? COLORS.mcp : COLORS.tool }, ctx)
    }

    // Track file attention
    if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
      const filePath = extractFilePath(inputData, args)
      if (filePath) {
        const prev = state.fileAttention.get(filePath)
        const updated = prev
          ? { ...prev, agents: [...prev.agents] }
          : { path: filePath, reads: 0, edits: 0, totalTokens: 0, lastAccessed: currentTime, agents: [] as string[] }
        if (toolName === 'Read') updated.reads++
        else updated.edits++
        updated.lastAccessed = currentTime
        if (!updated.agents.includes(agentName)) updated.agents.push(agentName)
        state.fileAttention.set(filePath, updated)
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_call', content: `> ${toolName} ${args}`, timestamp: currentTime,
      toolName, inputData, toolUseId,
    }, state.droppedMessages)
  }
}

export function handleToolCallEnd(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const agentName = agentKeyOf(sessionId, idString(payload.agent))
  const toolName = idString(payload.tool)
  const result = cappedString(payload.result, undefined, 'Done')
  // Absent stays null (never 0): a missing figure must not look like a free call
  const tokenCost = readTokenCost(payload.tokenCost)
  const tokenSource = readTokenSource(payload.tokenSource)
  const outcome = readToolOutcome(payload)
  const isError = outcome === 'error'
  const isCancelled = outcome === 'cancelled'
  const errorMessage = typeof payload.errorMessage === 'string' ? payload.errorMessage : undefined
  const toolUseId = idString(payload.toolUseId) || undefined
  const agent = state.agents.get(agentName)

  // A usage counts for an agent only if it addresses exactly one instance; otherwise it goes to the remainder (#61)
  const target = resolveUsageTarget(state.agents, sessionId, idString(payload.agent))
  if (target.kind !== 'attributed' && tokenCost) {
    addUnattributed(state.unattributed, sessionId, target.key, target.kind, tokenCost, 'add', tokenSource !== 'reported')
  }

  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      // A cancelled call is neither a success nor an agent failure
      state: outcome === 'error' ? 'error' : 'thinking',
      currentTool: undefined,
      // A usage addressing no single instance never lands on an agent (it went to the remainder above)
      ...(target.kind === 'attributed'
        ? addToken(agent, tokenCost, tokenSource)
        : {}),
      ...(isError ? { toolErrors: (agent.toolErrors ?? 0) + 1 } : {}),
    })

    const toolState: ToolCallNode['state'] = outcome === 'error' ? 'error' : outcome
    const matchedId = findCallToClose(state.toolCalls, agentName, toolName, toolUseId)
    for (const [id, tc] of state.toolCalls) {
      if (id === matchedId) {
        state.toolCalls.set(id, {
          ...tc, state: toolState, completeTime: currentTime, result, tokenCost, tokenSource, endObserved: true,
          errorMessage: isError ? (errorMessage || result) : undefined,
        })

        const edgeId = `edge-${id}`
        // Snap any still-traveling outgoing particle to the end
        const outIdx = state.particles.findIndex(p => p.edgeId === edgeId && p.type === 'tool_call')
        if (outIdx !== -1) state.particles[outIdx] = { ...state.particles[outIdx], progress: 0.95 }

        state.particles.push({
          id: `p-tr-${currentTime}-${id}`,
          edgeId, progress: 1,
          type: 'tool_return', color: COLORS.return,
          size: 4, trailLength: 0.15,
          label: result.slice(0, LABEL_LEN_PARTICLE),
        })
        break
      }
    }

    // Timeline block end
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      if (isError || isCancelled) {
        const lastBlock = entry.blocks[entry.blocks.length - 1]
        if (lastBlock && !lastBlock.endTime) {
          // A cancelled call is not a failure: neutral color, never the error red
          lastBlock.color = isError ? COLORS.error : COLORS.idle
          lastBlock.label = `${toolName}: ${isError ? 'FAILED' : 'CANCELLED'}`
        }
      }
      pushTimelineBlock(entry, currentTime, { type: 'thinking', label: 'Thinking...', color: COLORS.thinking }, ctx)
    }

    // File attention token cost
    if (tokenCost) { // 0 and null add nothing
      const matchedTc = Array.from(state.toolCalls.values()).find(tc => tc.agentId === agentName && tc.toolName === toolName)
      const filePath = extractFilePath(matchedTc?.inputData, matchedTc?.args)
      if (filePath) {
        const existing = state.fileAttention.get(filePath)
        if (existing) {
          state.fileAttention.set(filePath, { ...existing, totalTokens: existing.totalTokens + tokenCost })
        }
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_result',
      content: `< ${result}${tokenCost ? ` (${tokenCost} tokens${tokenSource === 'estimated' ? ', estimé' : ''})` : ''}`,
      timestamp: currentTime,
      toolName,
      toolUseId,
      ...(outcome === 'error' ? { isError: true } : {}),
    }, state.droppedMessages)
  }
}
