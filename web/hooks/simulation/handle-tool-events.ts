import { SCENE } from '../../lib/colors'
import { TOOL_DEDUP_WINDOW_S } from '../../lib/canvas-constants'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { appendConversation, asString, agentKeyOf, cappedString, DEFAULT_SESSION_ID, LABEL_LEN_PARTICLE, LABEL_LEN_TIMELINE } from './types'
import { idString } from './agent-keys'
import { parseMcpTool, formatToolName } from '../../lib/mcp-tool'
import { readToolOutcome } from '../../lib/tool-lifecycle'
import { readTokenCost, readTokenSource, effectiveTokenStatus } from '../../lib/usage'
import { USAGE_LABELS } from '../../lib/ui-glossary'
import type { Agent, ToolCallNode, FileAttention, FileEditor, FileReader, TimelineBlock } from '../../lib/agent-types'
import { resolveUsageTarget, addUnattributed } from '../../lib/attribution'
import { recordToolStart, recordToolEnd } from '../../lib/waste'
import { reviveFinished } from './revive-agent'
import { ghResultLink, isShellTool, searchResultCount, type ResultPill } from '../../lib/action-summary'
import { searchDiscoveries } from '../../lib/search-discoveries'
import { fileStepKind, recordFileStep } from '../../lib/file-timeline'
import { recordGitCall } from '../../lib/git-state'

/** Extract file path from tool input data or fall back to first token of args */
function extractFilePath(inputData?: Record<string, unknown>, args?: string): string {
  return asString(inputData?.file_path) || asString(inputData?.notebook_path) || args?.split(' ')[0] || ''
}

/** The pill a successful call's output proves (#317): the gh link of a shell call, or the Grep / Glob file count. */
function provenResultPill(tc: Pick<ToolCallNode, 'toolName' | 'inputData'>, result: string): ResultPill | null {
  if (isShellTool(tc.toolName)) {
    const command = asString(tc.inputData?.command)
    const link = command ? ghResultLink(command, result) : null
    return link && { kind: 'link', link }
  }
  const files = searchResultCount(tc.toolName, result)
  return files == null ? null : { kind: 'count', files }
}

/** Tools that write a file: their observed success is what proves a file conflict (#227) */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Copy of the file entry with one editor changed (created when absent). */
function withEditor(file: FileAttention, agent: string, change: (e: FileEditor) => FileEditor): FileAttention {
  const editors = file.editors ?? []
  const i = editors.findIndex(e => e.agent === agent)
  const next = editors.slice()
  if (i === -1) next.push(change({ agent, started: 0, succeeded: 0 }))
  else next[i] = change(editors[i])
  return { ...file, editors: next }
}

/** Copy of the file entry with one reader changed (created when absent). */
function withReader(file: FileAttention, agent: string, change: (r: FileReader) => FileReader): FileAttention {
  const readers = file.readers ?? []
  const i = readers.findIndex(r => r.agent === agent)
  const next = readers.slice()
  if (i === -1) next.push(change({ agent, started: 0, succeeded: 0 }))
  else next[i] = change(readers[i])
  return { ...file, readers: next }
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

/**
 * Index of the Timeline block of a call (the latest tool block that started with it and carries its tool name),
 * or -1. It may already be closed: a later block cuts the previous one.
 */
function findCallBlock(blocks: TimelineBlock[], tc: Pick<ToolCallNode, 'startTime' | 'toolName'>): number {
  const prefix = `${formatToolName(tc.toolName)}:`
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.type === 'tool_call' && b.startTime === tc.startTime && b.label.startsWith(prefix)) return i
  }
  return -1
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
  // A finished agent that starts a call never seen before is live again, prompt or not (#433)
  const seen = toolUseId !== undefined && state.agents.get(agentName)?.state === 'complete' && Array.from(state.toolCalls.values()).some(tc => tc.agentId === agentName && tc.toolUseId === toolUseId)
  const agent = reviveFinished(state, agentName, ctx, currentTime, !seen)

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

    state.waste = recordToolStart(state.waste, { sessionId, agentId: agentName, toolName, inputData, toolUseId, toolCallId: toolId, time: currentTime }, state.wasteToken)

    state.particles.push({
      id: `p-tc-${currentTime}-${toolId}`,
      edgeId: `edge-${toolId}`, progress: 0,
      type: 'tool_call', color: mcp ? SCENE.mcp : SCENE.tool,
      size: 4, trailLength: 0.15,
      ...(mcp ? { mcp: true } : {}),
      label: `${formatToolName(toolName)} ${args}`.slice(0, LABEL_LEN_PARTICLE),
    })

    // Timeline block
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      state.timelineEntries.set(agentName, pushTimelineBlock(entry, currentTime, { type: 'tool_call', label: `${formatToolName(toolName)}: ${args}`.slice(0, LABEL_LEN_TIMELINE), color: mcp ? SCENE.mcp : SCENE.tool }, ctx))
    }

    // Track file attention
    if (toolName === 'Read' || EDIT_TOOLS.has(toolName)) {
      const filePath = extractFilePath(inputData, args)
      if (filePath) {
        const prev = state.fileAttention.get(filePath)
        let updated: FileAttention = prev
          ? { ...prev, agents: [...prev.agents] }
          : { path: filePath, reads: 0, edits: 0, totalTokens: 0, lastAccessed: currentTime, agents: [] as string[] }
        if (toolName === 'Read') {
          updated.reads++
          updated = withReader(updated, agentName, r => ({ ...r, started: r.started + 1 }))
        } else {
          updated.edits++
          updated = withEditor(updated, agentName, e => ({ ...e, started: e.started + 1 }))
        }
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
  // Read from the result of the matched call, and only once it is known to have succeeded
  let pill: ResultPill | null = null

  // A usage counts for an agent only if it addresses exactly one instance; otherwise it goes to the remainder (#61)
  const target = resolveUsageTarget(state.agents, sessionId, idString(payload.agent))
  if (target.kind !== 'attributed' && tokenCost) {
    addUnattributed(state.unattributed, sessionId, target.key, target.kind, tokenCost, 'add', tokenSource !== 'reported')
  }

  if (agent) {
    const matchedId = findCallToClose(state.toolCalls, agentName, toolName, toolUseId)
    const matchedCall = matchedId ? state.toolCalls.get(matchedId) : undefined
    // Another call of this agent still running (a parallel batch): the agent is still calling that tool
    let stillRunning: ToolCallNode | undefined
    for (const [id, tc] of state.toolCalls) {
      if (id !== matchedId && tc.agentId === agentName && tc.state === 'running') stillRunning = tc
    }
    const nextState = stillRunning ? 'tool_calling' : 'idle'
    // A late result for a finished agent proves no work: it stays finished (#433)
    const finished = agent.state === 'complete'
    // Branch, commits and PR states this agent's own shell output proves (#386); a failed or unmatched call proves none
    const git = matchedId && matchedCall && isShellTool(matchedCall.toolName)
      ? recordGitCall(agent.git, { command: asString(matchedCall.inputData?.command), result, callId: matchedId, toolUseId: matchedCall.toolUseId ?? toolUseId, time: currentTime }, outcome)
      : agent.git
    state.agents.set(agentName, {
      ...agent,
      ...(git !== agent.git ? { git } : {}),
      // A failed or cancelled tool call is not an agent failure: the agent handles it and goes on (#363). The failure is counted in toolErrors; 'error' stays for the agent or the runtime.
      // What the agent does next is unknown until its next event: neutral, never a 'thinking' nobody observed (#362).
      // Its turn is not over though: idle between two steps, not at rest.
      state: finished ? 'complete' : nextState,
      ...(nextState === 'idle' && !finished ? { awaitingNextEvent: true } : {}),
      currentTool: finished ? undefined : stillRunning?.toolName,
      // A usage addressing no single instance never lands on an agent (it went to the remainder above)
      ...(target.kind === 'attributed'
        ? addToken(agent, tokenCost, tokenSource)
        : {}),
      ...(isError ? { toolErrors: (agent.toolErrors ?? 0) + 1 } : {}),
    })

    const toolState: ToolCallNode['state'] = outcome === 'error' ? 'error' : outcome
    for (const [id, tc] of state.toolCalls) {
      if (id === matchedId) {
        pill = toolState === 'complete' ? provenResultPill(tc, result) : null
        state.toolCalls.set(id, {
          ...tc, state: toolState, completeTime: currentTime, result, tokenCost, tokenSource, endObserved: true,
          errorMessage: isError ? (errorMessage || result) : undefined,
          ...(pill ? { resultPill: pill } : {}),
        })

        // A file conflict needs a write that is known to have happened: only an observed success counts
        if (toolState === 'complete' && EDIT_TOOLS.has(tc.toolName)) {
          const filePath = extractFilePath(tc.inputData, tc.args)
          const file = filePath ? state.fileAttention.get(filePath) : undefined
          if (file) state.fileAttention.set(filePath, withEditor(file, agentName, e => ({ ...e, succeeded: e.succeeded + 1, lastEditTime: currentTime })))
        }
        // A file counts as read by the agent only once its Read was observed to succeed (#233)
        if (toolState === 'complete' && tc.toolName === 'Read') {
          const filePath = extractFilePath(tc.inputData, tc.args)
          const file = filePath ? state.fileAttention.get(filePath) : undefined
          if (file) state.fileAttention.set(filePath, withReader(file, agentName, r => ({ ...r, succeeded: r.succeeded + 1 })))
        }
        // One timeline step per call observed to succeed, tied to that call (#385); a failure or a cancellation adds none
        const stepKind = fileStepKind(tc.toolName)
        if (stepKind) {
          const filePath = extractFilePath(tc.inputData, tc.args)
          const file = filePath ? state.fileAttention.get(filePath) : undefined
          const stepUseId = tc.toolUseId ?? toolUseId
          const timeline = file && recordFileStep(file.timeline, {
            kind: stepKind, callId: id, agentId: agentName, time: currentTime, ...(stepUseId ? { toolUseId: stepUseId } : {}),
          }, toolState)
          if (file && timeline !== file.timeline) state.fileAttention.set(filePath, { ...file, timeline })
        }
        // File cards for the paths a successful Glob / Grep output lists itself (#438); a replayed result reuses the ids
        if (toolState === 'complete') {
          const cards = searchDiscoveries({ ...tc, toolUseId: tc.toolUseId ?? toolUseId }, result, currentTime)
          for (const d of cards) if (!state.discoveries.some(x => x.id === d.id)) state.discoveries.push(d)
        }
        state.waste = recordToolEnd(state.waste, id, tokenCost, tokenSource, state.wasteToken,
          toolState === 'complete' ? undefined : { sessionId, agentId: agentName, toolName: tc.toolName, inputData: tc.inputData, toolUseId: tc.toolUseId, toolCallId: id, time: currentTime })

        const edgeId = `edge-${id}`
        // Snap any still-traveling outgoing particle to the end
        const outIdx = state.particles.findIndex(p => p.edgeId === edgeId && p.type === 'tool_call')
        if (outIdx !== -1) state.particles[outIdx] = { ...state.particles[outIdx], progress: 0.95 }

        state.particles.push({
          id: `p-tr-${currentTime}-${id}`,
          edgeId, progress: 1,
          type: 'tool_return', color: SCENE.return,
          size: 4, trailLength: 0.15,
          label: result.slice(0, LABEL_LEN_PARTICLE),
        })
        break
      }
    }

    // Timeline block end
    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      // The block of the call that ended, never the block of another call still running (#362). Without a
      // matched call (an end whose start was not seen), the last open block, as long as no other call runs.
      const blocks = entry.blocks.slice()
      const last = blocks.length - 1
      const own = matchedCall ? findCallBlock(blocks, matchedCall) : -1
      const idx = own >= 0 ? own : !stillRunning && last >= 0 && !blocks[last].endTime ? last : -1
      if (idx >= 0) {
        let block = blocks[idx]
        // A cancelled call is not a failure: neutral color, never the error red
        if (isError || isCancelled) block = { ...block, color: isError ? SCENE.error : SCENE.idle, label: `${toolName}: ${isError ? 'FAILED' : 'CANCELLED'}` }
        if (block.endTime === undefined) block = { ...block, endTime: currentTime }
        blocks[idx] = block
      }
      // No other call runs: whatever block is still open (a permission wait) ends here too. No 'Thinking...'
      // block opens until a thinking block is observed.
      const closeTrailing = !stillRunning && last >= 0 && blocks[last].endTime === undefined
      if (closeTrailing) blocks[last] = { ...blocks[last], endTime: currentTime }
      if (idx >= 0 || closeTrailing) state.timelineEntries.set(agentName, { ...entry, blocks })
    }

    // File attention token cost: the figure of the call that just ended, never the first call of this tool
    // the agent ever made. A call that ended without a figure leaves the file total a lower bound (#368).
    {
      const matchedTc = matchedId ? state.toolCalls.get(matchedId) : undefined
      const filePath = matchedTc ? extractFilePath(matchedTc.inputData, matchedTc.args) : undefined
      const existing = filePath ? state.fileAttention.get(filePath) : undefined
      if (filePath && existing) {
        if (tokenCost === null) {
          state.fileAttention.set(filePath, { ...existing, tokensPartial: true })
        } else if (tokenCost) { // 0 adds nothing
          state.fileAttention.set(filePath, {
            ...existing,
            totalTokens: existing.totalTokens + tokenCost,
            ...(tokenSource === 'estimated' ? { tokensEstimated: true } : {}),
          })
        }
      }
    }

    appendConversation(state.conversations, agentName, {
      type: 'tool_result',
      content: `< ${result}${tokenCost ? ` (${tokenCost} tokens${tokenSource === 'estimated' ? `, ${USAGE_LABELS.estimated}` : ''})` : ''}`,
      timestamp: currentTime,
      toolName,
      toolUseId,
      ...(outcome === 'error' ? { isError: true } : {}),
      ...(pill ? { resultPill: pill } : {}),
    }, state.droppedMessages)
  }
}
