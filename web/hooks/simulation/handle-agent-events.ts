import {
  type Agent,
  type TimelineEntry,
  emptyContextBreakdown,
} from '../../lib/agent-types'
import { COLORS } from '../../lib/colors'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { edgeId, asBoolean, agentKeyOf, cappedString, LABEL_LEN_NAME, MAX_ID_LEN, DEFAULT_SESSION_ID } from './types'
import { idString, resolveChildLocalId } from './agent-keys'
import { parseTeammateExtras } from './team-info'
import { evictArchived } from './archive'
import { spawnPosition, clusterKeyOf } from './fleet-layout'

export function handleAgentSpawn(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const toolUseId = idString(payload.toolUseId) || undefined
  const rawName = idString(payload.name)
  const localId = resolveChildLocalId(state.agents, sessionId, rawName, toolUseId)
  const name = agentKeyOf(sessionId, localId)
  const label = cappedString(payload.label, LABEL_LEN_NAME * 2).trim()
  const rawParent = idString(payload.parent)
  // The real parent comes from the event. If it is not known (yet), hang the agent on the
  // session's main agent rather than leaving a dangling edge.
  let parentId: string | undefined
  if (rawParent) {
    const direct = agentKeyOf(sessionId, rawParent)
    if (state.agents.has(direct)) parentId = direct
    else {
      const main = Array.from(state.agents.values()).find(a => a.sessionId === sessionId && a.isMain && a.id !== name)
      parentId = main ? main.id : direct
    }
  }
  const isMain = asBoolean(payload.isMain)
  const task = typeof payload.task === 'string' ? cappedString(payload.task) : undefined
  const model = typeof payload.model === 'string' ? cappedString(payload.model, MAX_ID_LEN) : undefined
  const runtime = payload.runtime === 'codex' ? 'codex' as const : undefined

  const team = parseTeammateExtras(payload)
  const teamFields = team ? {
    kind: 'teammate' as const,
    teamName: team.teamName,
    ...(team.teamColor ? { teamColor: team.teamColor } : {}),
    activity: 'working' as const,
    ...(team.agentType ? { agentType: team.agentType } : {}),
    ...(team.backend ? { backend: team.backend } : {}),
  } : {}

  // If the agent already exists (e.g. session resuming after inactivity),
  // reactivate it instead of replacing — preserves accumulated stats.
  const existing = state.agents.get(name)
  if (existing) {
    state.agents.set(name, {
      ...existing,
      state: 'idle',
      // A returning agent is live again: undo archiving
      archived: false,
      completeTime: undefined,
      ...(existing.kind === 'teammate' ? { activity: 'working' as const } : {}),
      ...teamFields,
      ...(task ? { task } : {}),
      ...(model ? { model, tokensMax: ctx.getContextWindowSize(model) } : {}),
      ...(runtime ? { runtime } : {}),
      ...(toolUseId && !existing.toolUseId ? { toolUseId } : {}),
    })
    return
  }

  // Position: around the parent / cluster lead, or at the cluster anchor (never a shared origin)
  const { x, y } = spawnPosition(state.agents, { id: name, sessionId, teamName: team?.teamName, isMain, localId, parentId: parentId ?? null }, state.teams)

  const displayName = label || localId
  const agent: Agent = {
    id: name, agentKey: name, sessionId, localId, displayName, name: displayName, state: 'idle',
    parentId: parentId || null,
    parentKey: parentId || null,
    ...(toolUseId ? { toolUseId } : {}),
    tokensUsed: 0, tokensMax: ctx.getContextWindowSize(model),
    contextBreakdown: emptyContextBreakdown(),
    toolCalls: 0, timeAlive: 0,
    x, y, vx: 0, vy: 0,
    pinned: false, isMain,
    ...(runtime ? { runtime } : {}),
    ...(model ? { model } : {}),
    ...teamFields,
    clusterKey: clusterKeyOf({ sessionId, teamName: team?.teamName }, state.teams),
    task,
    spawnTime: currentTime,
    opacity: 0, scale: 0.3,
    messageBubbles: [],
  }
  state.agents.set(name, agent)

  if (parentId) {
    state.edges.push({ id: edgeId(parentId, name), from: parentId, to: name, type: 'parent-child', opacity: 0 })
  }

  const timelineEntry: TimelineEntry = {
    id: `timeline-${name}`,
    agentId: name,
    agentName: displayName,
    startTime: currentTime,
    blocks: [],
  }
  pushTimelineBlock(timelineEntry, currentTime, { type: 'idle', label: 'Starting', color: COLORS.idle }, ctx)
  state.timelineEntries.set(name, timelineEntry)

  // A subagent_dispatch is emitted just before agent_spawn and may already have
  // recorded the prompt in the child's conversation — keep it.
  if (!state.conversations.has(name)) state.conversations.set(name, [])

  if (!ctx.skipForceSync) {
    setTimeout(() => ctx.syncForceSimulation(state.agents, state.edges), 0)
  }
}

export function handleAgentComplete(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const name = agentKeyOf(sessionId, idString(payload.name))
  const agent = state.agents.get(name)
  if (agent && agent.state !== 'complete') {
    state.agents.set(name, { ...agent, state: 'complete', completeTime: currentTime, archived: true, ...(agent.kind === 'teammate' ? { activity: 'done' as const } : {}) })

    const entry = state.timelineEntries.get(name)
    if (entry) {
      pushTimelineBlock(entry, currentTime, { type: 'complete', label: 'Done', color: COLORS.complete, endTime: currentTime }, ctx)
      entry.endTime = currentTime
    }

    const agentsToComplete = [name]
    for (const [childId, childAgent] of state.agents) {
      if (childAgent.parentId === name && childAgent.state !== 'complete') {
        state.agents.set(childId, { ...childAgent, state: 'complete', completeTime: currentTime, archived: true, ...(childAgent.kind === 'teammate' ? { activity: 'done' as const } : {}) })
        agentsToComplete.push(childId)
        const childEntry = state.timelineEntries.get(childId)
        if (childEntry) {
          pushTimelineBlock(childEntry, currentTime, { type: 'complete', label: 'Done', color: COLORS.complete, endTime: currentTime }, ctx)
          childEntry.endTime = currentTime
        }
      }
    }

    for (const [tcId, tc] of state.toolCalls) {
      if (agentsToComplete.includes(tc.agentId) && tc.state === 'running') {
        state.toolCalls.set(tcId, { ...tc, state: 'complete', completeTime: currentTime })
      }
    }

    // Finished agents are kept (archived), never dropped: only the per-session cap evicts the oldest
    evictArchived(state, sessionId)
  }
}

export function handlePermissionRequested(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const agentName = agentKeyOf(sessionId, idString(payload.agent) || 'Orchestrator')
  const agent = state.agents.get(agentName)
  if (agent && agent.state !== 'complete') {
    state.agents.set(agentName, {
      ...agent,
      state: 'waiting_permission',
    })

    const entry = state.timelineEntries.get(agentName)
    if (entry) {
      pushTimelineBlock(entry, currentTime, { type: 'idle', label: 'Permission', color: COLORS.waiting_permission }, ctx)
    }
  }
}

export function handleAgentIdle(
  payload: Record<string, unknown>,
  state: MutableEventState,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const idleName = agentKeyOf(sessionId, idString(payload.name))
  const idleAgent = state.agents.get(idleName)
  if (idleAgent && (idleAgent.state === 'tool_calling' || idleAgent.state === 'waiting_permission')) {
    state.agents.set(idleName, { ...idleAgent, state: 'thinking', currentTool: undefined })
  }
}

export function handleModelDetected(
  payload: Record<string, unknown>,
  state: MutableEventState,
  ctx: ProcessEventContext,
  sessionId: string = DEFAULT_SESSION_ID,
): void {
  const agentName = agentKeyOf(sessionId, idString(payload.agent))
  const model = cappedString(payload.model, MAX_ID_LEN)
  const agent = state.agents.get(agentName)
  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      model,
      tokensMax: ctx.getContextWindowSize(model),
    })
  }
}
