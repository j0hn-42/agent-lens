import {
  type Agent,
  type TimelineEntry,
  emptyContextBreakdown,
} from '../../lib/agent-types'
import { COLORS } from '../../lib/colors'
import type { ModelSource } from '../../lib/model-provenance'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { edgeId, asBoolean, agentKeyOf, cappedString, LABEL_LEN_NAME, MAX_ID_LEN, DEFAULT_SESSION_ID } from './types'
import { idString, resolveChildLocalId } from './agent-keys'
import { parseTeammateExtras } from './team-info'
import { evictArchived, admitSpawn } from './archive'
import { spawnPosition, clusterKeyOf } from './fleet-layout'
import { expireToolCall } from '../../lib/tool-lifecycle'
import { judgeSpawn } from './edge-validation'
import { advanceActiveTime } from '../../lib/active-time'
import { isPseudoModel, mergeModel, parseEffort, parseModelSource, recordModelUsed } from '../../lib/model-provenance'

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
  let parentResolved = true
  if (rawParent) {
    const direct = agentKeyOf(sessionId, rawParent)
    if (state.agents.has(direct)) parentId = direct
    else {
      parentResolved = false
      const main = Array.from(state.agents.values()).find(a => a.sessionId === sessionId && a.isMain && a.id !== name)
      parentId = main ? main.id : direct
    }
  }
  const isMain = asBoolean(payload.isMain)
  const task = typeof payload.task === 'string' ? cappedString(payload.task) : undefined
  const model = typeof payload.model === 'string' ? cappedString(payload.model, MAX_ID_LEN) : undefined
  // A model without a (valid) source is only what was asked for, never "what ran"
  const modelSource = parseModelSource(payload.modelSource) ?? 'requested'
  const requestedModel = typeof payload.requestedModel === 'string' ? cappedString(payload.requestedModel, MAX_ID_LEN) || undefined : undefined
  const effort = parseEffort(payload.effort)
  const subagentType = typeof payload.subagentType === 'string' ? cappedString(payload.subagentType, MAX_ID_LEN) || undefined : undefined
  const runtime = payload.runtime === 'codex' ? 'codex' as const : undefined

  const team = parseTeammateExtras(payload)
  const teamFields = team ? {
    kind: 'teammate' as const,
    teamName: team.teamName,
    ...(team.teamKind ? { teamKind: team.teamKind } : {}),
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
      // A returning teammate may carry a team name it did not have: keep the cached cluster key right
      ...(team ? { clusterKey: clusterKeyOf({ sessionId, teamName: team.teamName }, state.teams) } : {}),
      ...(task ? { task } : {}),
      ...spawnModelFields(existing, { model, modelSource, requestedModel }, ctx),
      ...(effort ? { effort } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...(runtime ? { runtime } : {}),
      ...(toolUseId && !existing.toolUseId ? { toolUseId } : {}),
    })
    return
  }

  // Bounded state: caps per team / per session / overall; refused when nothing finished can make room
  if (!admitSpawn(state, { sessionId, isMain, teamName: team?.teamName })) return

  // Position: around the parent / cluster lead, or at the cluster anchor (never a shared origin)
  const clusterKey = clusterKeyOf({ sessionId, teamName: team?.teamName }, state.teams)
  const { x, y } = spawnPosition(state.agents, { id: name, sessionId, teamName: team?.teamName, clusterKey, isMain, localId, parentId: parentId ?? null }, state.teams)

  const displayName = label || localId
  const initialModel = mergeModel({}, { model: model ?? requestedModel ?? '', source: model ? modelSource : 'requested' }) ?? undefined
  // Usage that arrived before the agent existed is now unambiguous: hand it over once, only if it was an orphan
  const early = state.unattributed.get(name)
  const lateUsage = early && early.reason === 'orphan' ? early.tokens : 0
  if (early && early.reason === 'orphan') state.unattributed.delete(name)
  const agent: Agent = {
    id: name, agentKey: name, sessionId, localId, displayName, name: displayName, state: 'idle',
    parentId: parentId || null,
    parentKey: parentId || null,
    ...(toolUseId ? { toolUseId } : {}),
    tokensUsed: lateUsage, tokenStatus: lateUsage > 0 ? 'available' : 'unavailable', tokenGaps: 0, tokensEstimated: lateUsage > 0 && early?.estimated === true,
    tokensMax: ctx.getContextWindowSize(initialModel?.model),
    contextBreakdown: emptyContextBreakdown(),
    toolCalls: 0, toolErrors: 0, timeAlive: 0,
    x, y, vx: 0, vy: 0,
    pinned: false, isMain,
    ...(runtime ? { runtime } : {}),
    ...(initialModel ?? {}),
    ...(requestedModel ? { requestedModel } : {}),
    ...(effort ? { effort } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...teamFields,
    clusterKey,
    task,
    spawnTime: currentTime,
    opacity: 0, scale: 0.3,
    messageBubbles: [],
  }
  state.agents.set(name, agent)

  if (parentId) {
    // The edge is a fact only if the events agree (#54); otherwise it stays "unverified"
    const verdict = judgeSpawn(state, { sessionId, parentKey: parentId, childKey: name, toolUseId, parentResolved }, currentTime)
    state.edges.push({
      id: edgeId(parentId, name), from: parentId, to: name, type: 'parent-child', opacity: 0,
      verified: verdict.verified,
      ...(verdict.verified ? {} : { unverifiedReason: verdict.reason }),
    })
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
    // An inactivity timeout is not a witnessed end: the work stopped at the last event heard from the agent
    const lastHeard = asBoolean(payload.inactivity) && agent.activeSince !== undefined && agent.lastEventAt !== undefined
      ? advanceActiveTime({ activeMs: agent.activeMs, activeSince: agent.activeSince }, false, Math.max(agent.lastEventAt, agent.activeSince))
      : {}
    const { activeSince: _since, ...settled } = agent
    state.agents.set(name, {
      ...(Object.keys(lastHeard).length ? settled : agent), ...lastHeard,
      state: 'complete', completeTime: currentTime, archived: true, ...(agent.kind === 'teammate' ? { activity: 'done' as const } : {}),
    })

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

    // The agent is gone but these calls never reported an end: expired, not completed
    for (const [tcId, tc] of state.toolCalls) {
      if (agentsToComplete.includes(tc.agentId) && tc.state === 'running') {
        state.toolCalls.set(tcId, expireToolCall(tc, currentTime))
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
  if (!idleAgent) return
  // End of a turn: the agent is waiting for the next prompt, not working (its active span closes)
  if (asBoolean(payload.turnEnd) && (idleAgent.state === 'thinking' || idleAgent.state === 'tool_calling' || idleAgent.state === 'waiting_permission')) {
    state.agents.set(idleName, { ...idleAgent, state: 'idle', currentTool: undefined })
  } else if (idleAgent.state === 'tool_calling' || idleAgent.state === 'waiting_permission') {
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
  const effort = parseEffort(payload.effort)
  const agent = state.agents.get(agentName)
  if (agent && model && !isPseudoModel(model)) {
    // Reported by the transcript itself: the strongest source
    const merged = mergeModel(agent, { model, source: 'runtime' })
    // A Codex report is authoritative for the effort (re-emitted when it changes, absent = none), and a
    // switch to another model no longer carries the effort configured for the previous one. Claude's own
    // reports never carry an effort: there the one configured at spawn stays.
    const effortStale = !effort && (agent.runtime === 'codex' || (!!agent.model && agent.model !== model))
    const { effort: _previous, ...withoutEffort } = agent
    const rest = effortStale ? withoutEffort : agent
    state.agents.set(agentName, {
      ...rest,
      ...merged,
      modelsUsed: recordModelUsed(agent.modelsUsed, model),
      tokensMax: ctx.getContextWindowSize(model),
      ...(effort ? { effort } : {}),
    })
  }
}

/** Model fields to merge into a returning agent: the requested model is remembered, the shown model follows priority. */
function spawnModelFields(
  agent: Agent,
  incoming: { model?: string; modelSource: ModelSource; requestedModel?: string },
  ctx: ProcessEventContext,
): Partial<Agent> {
  const out: Partial<Agent> = {}
  if (incoming.requestedModel) out.requestedModel = incoming.requestedModel
  const candidate = incoming.model
    ? { model: incoming.model, source: incoming.modelSource }
    : incoming.requestedModel ? { model: incoming.requestedModel, source: 'requested' as const } : undefined
  const merged = candidate ? mergeModel(agent, candidate) : null
  if (merged) {
    out.model = merged.model
    out.modelSource = merged.modelSource
    if (merged.model !== agent.model) out.tokensMax = ctx.getContextWindowSize(merged.model)
  }
  return out
}
