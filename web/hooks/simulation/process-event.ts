import {
  Agent,
  ToolCallNode,
  Edge,
  SimulationEvent,
  type TeamSummary,
  type TimelineEntry,
  type TimelineBlock,
} from '../../lib/agent-types'
import type { SimulationState, ConversationMessage, AgentLink } from './types'
import { DEFAULT_SESSION_ID } from './types'
import { handleAgentSpawn, handleAgentComplete, handleAgentIdle, handlePermissionRequested, handleModelDetected } from './handle-agent-events'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import { handleMessage, handleContextUpdate } from './handle-message-events'
import { handleSubagentDispatch, handleSubagentReturn } from './handle-subagent-events'
import { handleAgentLink, handleMessageSent } from './handle-link-events'
import { handleTeamInfo, handleAgentActivity } from './handle-team-events'

export interface ProcessEventContext {
  syncForceSimulation: (agents: Map<string, Agent>, edges: Edge[]) => void
  findToolSlot: (agent: Agent, agents: Map<string, Agent>, toolCalls: Map<string, ToolCallNode>, currentTime: number) => { x: number; y: number }
  getContextWindowSize: (modelId?: string) => number
  blockIdCounter: { current: number }
  skipForceSync: boolean
}

/** Mutable collections that handlers mutate in place during a single processEvent call. */
export interface MutableEventState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  particles: SimulationState['particles']
  edges: Edge[]
  discoveries: SimulationState['discoveries']
  fileAttention: SimulationState['fileAttention']
  timelineEntries: SimulationState['timelineEntries']
  conversations: Map<string, ConversationMessage[]>
  links: Map<string, AgentLink>
  teams: Map<string, TeamSummary>
  droppedMessages: Map<string, number>
}

/** Session an event belongs to; events without a session id share the 'default' session. */
export function eventSessionId(event: Pick<SimulationEvent, 'sessionId'>): string {
  return typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : DEFAULT_SESSION_ID
}

/** Close the last open block on a timeline entry and push a new one. */
export function pushTimelineBlock(
  entry: TimelineEntry,
  currentTime: number,
  block: Pick<TimelineBlock, 'type' | 'label' | 'color'> & { endTime?: number },
  ctx: ProcessEventContext,
): void {
  const lastBlock = entry.blocks[entry.blocks.length - 1]
  if (lastBlock && !lastBlock.endTime) lastBlock.endTime = currentTime
  entry.blocks.push({
    id: `block-${ctx.blockIdCounter.current++}`,
    type: block.type,
    startTime: currentTime,
    endTime: block.endTime,
    label: block.label,
    color: block.color,
  })
}

/** Shallow-compare two Maps by reference equality of values */
function mapsEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** Particles kept at once (oldest dropped) */
export const MAX_PARTICLES = 500

export function processEvent(event: SimulationEvent, prev: SimulationState, ctx: ProcessEventContext): SimulationState {
      const state: MutableEventState = {
        agents: new Map(prev.agents),
        toolCalls: new Map(prev.toolCalls),
        particles: [...prev.particles],
        edges: [...prev.edges],
        discoveries: [...prev.discoveries],
        fileAttention: new Map(prev.fileAttention),
        timelineEntries: new Map(prev.timelineEntries),
        conversations: new Map(prev.conversations),
        links: new Map(prev.links),
        teams: new Map(prev.teams),
        droppedMessages: new Map(prev.droppedMessages),
      }
      const sid = eventSessionId(event)

      switch (event.type) {
        case 'agent_spawn':       handleAgentSpawn(event.payload, prev.currentTime, state, ctx, sid); break
        case 'agent_complete':    handleAgentComplete(event.payload, prev.currentTime, state, ctx, sid); break
        case 'agent_idle':        handleAgentIdle(event.payload, state, sid); break
        case 'model_detected':    handleModelDetected(event.payload, state, ctx, sid); break
        case 'tool_call_start':   handleToolCallStart(event.payload, prev.currentTime, state, ctx, sid); break
        case 'tool_call_end':     handleToolCallEnd(event.payload, prev.currentTime, state, ctx, sid); break
        case 'message':           handleMessage(event.payload, prev.currentTime, state, sid); break
        case 'context_update':    handleContextUpdate(event.payload, state, sid); break
        case 'subagent_dispatch': handleSubagentDispatch(event.payload, prev.currentTime, state, sid); break
        case 'subagent_return':   handleSubagentReturn(event.payload, prev.currentTime, state, sid); break
        case 'agent_link':        handleAgentLink(event.payload, prev.currentTime, state, sid); break
        case 'message_sent':      handleMessageSent(event.payload, prev.currentTime, state, sid); break
        case 'team_info':         handleTeamInfo(event.payload, state); break
        case 'agent_activity':    handleAgentActivity(event.payload, prev.currentTime, state, ctx, sid); break
        case 'permission_requested': handlePermissionRequested(event.payload, prev.currentTime, state, ctx, sid); break
      }

      // Particles normally expire as frames animate; a burst of events between two frames must not pile them up
      if (state.particles.length > MAX_PARTICLES) state.particles = state.particles.slice(-MAX_PARTICLES)

      // Stabilize references for unchanged collections to prevent
      // downstream React useMemo/re-render cascades (O(n log n) sorts etc.)
      return {
        ...prev,
        agents: state.agents, toolCalls: state.toolCalls,
        particles: state.particles, edges: state.edges,
        discoveries: state.discoveries,
        fileAttention: mapsEqual(prev.fileAttention, state.fileAttention) ? prev.fileAttention : state.fileAttention,
        timelineEntries: mapsEqual(prev.timelineEntries, state.timelineEntries) ? prev.timelineEntries : state.timelineEntries,
        conversations: mapsEqual(prev.conversations, state.conversations) ? prev.conversations : state.conversations,
        links: mapsEqual(prev.links, state.links) ? prev.links : state.links,
        teams: mapsEqual(prev.teams, state.teams) ? prev.teams : state.teams,
        droppedMessages: mapsEqual(prev.droppedMessages, state.droppedMessages) ? prev.droppedMessages : state.droppedMessages,
      }
}
