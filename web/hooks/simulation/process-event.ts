import {
  Agent,
  ToolCallNode,
  Edge,
  SimulationEvent,
  type TeamSummary,
  type TimelineEntry,
  type TimelineBlock,
} from '../../lib/agent-types'
import type { UnattributedUsage } from '../../lib/attribution'
import type { SimulationState, ConversationMessage, AgentLink } from './types'
import { DEFAULT_SESSION_ID } from './types'
import { handleAgentSpawn, handleAgentComplete, handleAgentIdle, handlePermissionRequested, handleModelDetected } from './handle-agent-events'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import { handleMessage, handleContextUpdate } from './handle-message-events'
import { handleSubagentDispatch, handleSubagentReturn } from './handle-subagent-events'
import { handleAgentLink, handleMessageSent } from './handle-link-events'
import { handleTeamInfo, handleAgentActivity } from './handle-team-events'
import { heardFrom } from './freshness'
import { advanceAgentActiveTime } from './track-active-time'

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
  unattributed: Map<string, UnattributedUsage>
  droppedMessages: Map<string, number>
}

/** Session an event belongs to; events without a session id share the 'default' session. */
export function eventSessionId(event: Pick<SimulationEvent, 'sessionId'>): string {
  return typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : DEFAULT_SESSION_ID
}

/**
 * Copy of `entry` with its last open block closed and a new block appended.
 * Never mutates `entry`: it may belong to the previous state (#214).
 */
export function pushTimelineBlock(
  entry: TimelineEntry,
  currentTime: number,
  block: Pick<TimelineBlock, 'type' | 'label' | 'color'> & { endTime?: number },
  ctx: ProcessEventContext,
): TimelineEntry {
  const blocks = entry.blocks.slice()
  const last = blocks.length - 1
  if (last >= 0 && !blocks[last].endTime) blocks[last] = { ...blocks[last], endTime: currentTime }
  blocks.push({
    id: `block-${ctx.blockIdCounter.current++}`,
    type: block.type,
    startTime: currentTime,
    endTime: block.endTime,
    label: block.label,
    color: block.color,
  })
  return { ...entry, blocks }
}

/** Shallow-compare two Maps by reference equality of values */
function mapsEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** Particles kept at once (oldest dropped) */
export const MAX_PARTICLES = 500

function copyCollections(prev: SimulationState): MutableEventState {
  return {
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
    unattributed: new Map(prev.unattributed),
    droppedMessages: new Map(prev.droppedMessages),
  }
}

/** Run the handler of one event on the mutable collections, at `currentTime`. */
function applyEvent(event: SimulationEvent, currentTime: number, state: MutableEventState, ctx: ProcessEventContext): void {
  const sid = eventSessionId(event)
  switch (event.type) {
    case 'agent_spawn':       handleAgentSpawn(event.payload, currentTime, state, ctx, sid); break
    case 'agent_complete':    handleAgentComplete(event.payload, currentTime, state, ctx, sid); break
    case 'agent_idle':        handleAgentIdle(event.payload, state, sid); break
    case 'model_detected':    handleModelDetected(event.payload, state, ctx, sid); break
    case 'tool_call_start':   handleToolCallStart(event.payload, currentTime, state, ctx, sid); break
    case 'tool_call_end':     handleToolCallEnd(event.payload, currentTime, state, ctx, sid); break
    case 'message':           handleMessage(event.payload, currentTime, state, sid); break
    case 'context_update':    handleContextUpdate(event.payload, state, sid); break
    case 'subagent_dispatch': handleSubagentDispatch(event.payload, currentTime, state, sid); break
    case 'subagent_return':   handleSubagentReturn(event.payload, currentTime, state, sid); break
    case 'agent_link':        handleAgentLink(event.payload, currentTime, state, sid); break
    case 'message_sent':      handleMessageSent(event.payload, currentTime, state, sid); break
    case 'team_info':         handleTeamInfo(event.payload, state, ctx); break
    case 'agent_activity':    handleAgentActivity(event.payload, currentTime, state, ctx, sid); break
    case 'permission_requested': handlePermissionRequested(event.payload, currentTime, state, ctx, sid); break
  }
  // Particles normally expire as frames animate; a burst of events between two frames must not pile them up
  if (state.particles.length > MAX_PARTICLES) state.particles.splice(0, state.particles.length - MAX_PARTICLES)
}

/** The next state from the mutated collections, reusing the references of the unchanged ones. */
function publish(prev: SimulationState, state: MutableEventState, currentTime: number): SimulationState {
  // Stabilize references for unchanged collections to prevent
  // downstream React useMemo/re-render cascades (O(n log n) sorts etc.)
  return {
    ...prev,
    currentTime,
    agents: state.agents, toolCalls: state.toolCalls,
    particles: state.particles, edges: state.edges,
    discoveries: state.discoveries,
    fileAttention: mapsEqual(prev.fileAttention, state.fileAttention) ? prev.fileAttention : state.fileAttention,
    timelineEntries: mapsEqual(prev.timelineEntries, state.timelineEntries) ? prev.timelineEntries : state.timelineEntries,
    conversations: mapsEqual(prev.conversations, state.conversations) ? prev.conversations : state.conversations,
    links: mapsEqual(prev.links, state.links) ? prev.links : state.links,
    teams: mapsEqual(prev.teams, state.teams) ? prev.teams : state.teams,
    unattributed: mapsEqual(prev.unattributed, state.unattributed) ? prev.unattributed : state.unattributed,
    droppedMessages: mapsEqual(prev.droppedMessages, state.droppedMessages) ? prev.droppedMessages : state.droppedMessages,
  }
}

export function processEvent(event: SimulationEvent, prev: SimulationState, ctx: ProcessEventContext): SimulationState {
  const state = copyCollections(prev)
  applyEvent(event, prev.currentTime, state, ctx)
  return publish(prev, state, prev.currentTime)
}

/**
 * Records, for one event at a time, the agents written to `agents` and the object each one had before
 * the event (undefined: a new agent). The handlers write through `set` / `delete`: both are wrapped on
 * this instance only, and `restore` puts the Map back as a plain Map.
 */
function recordAgentWrites(agents: Map<string, Agent>) {
  const before = new Map<string, Agent | undefined>()
  const remember = (id: string) => { if (!before.has(id)) before.set(id, Map.prototype.get.call(agents, id) as Agent | undefined) }
  Object.defineProperty(agents, 'set', {
    configurable: true, enumerable: false, writable: true,
    value(id: string, agent: Agent) { remember(id); return Map.prototype.set.call(agents, id, agent) },
  })
  Object.defineProperty(agents, 'delete', {
    configurable: true, enumerable: false, writable: true,
    value(id: string) { remember(id); return Map.prototype.delete.call(agents, id) },
  })
  return {
    before,
    restore() {
      delete (agents as unknown as Record<string, unknown>).set
      delete (agents as unknown as Record<string, unknown>).delete
    },
  }
}

export interface EventBatchOptions {
  /** First event of `events` to process (default 0) */
  from?: number
  /** Each event runs at its own time and the clock follows it (replay, catch-up); otherwise the clock of `prev` */
  advanceClock?: boolean
  /**
   * Wall clock (ms) the events were received at (live path): after each event, the agents it touched are
   * heard from at that time and, unless the event is a replayed one, their active span moves.
   */
  receivedAt?: number
  /** Asked after each event; true stops the batch there (frame budget) */
  shouldYield?: () => boolean
}

/**
 * Several events reduced in one pass (#210): the collections are copied once for the batch, not once per
 * event, and only the agents an event touched are stamped. The result is the one of `processEvent` applied
 * event by event (with `stampTouchedAgents` / `trackActiveTime` after each one on the live path).
 */
export function processEventBatch(
  events: readonly SimulationEvent[],
  prev: SimulationState,
  ctx: ProcessEventContext,
  opts: EventBatchOptions = {},
): { state: SimulationState; processed: number } {
  const from = opts.from ?? 0
  if (from >= events.length) return { state: prev, processed: 0 }
  const state = copyCollections(prev)
  const receivedAt = opts.receivedAt
  const writes = receivedAt !== undefined ? recordAgentWrites(state.agents) : null
  let currentTime = prev.currentTime
  let processed = 0
  try {
    for (let i = from; i < events.length; i++) {
      const event = events[i]
      if (opts.advanceClock) currentTime = event.time
      writes?.before.clear()
      applyEvent(event, currentTime, state, ctx)
      if (writes && receivedAt !== undefined) {
        for (const [id, before] of writes.before) {
          const agent = Map.prototype.get.call(state.agents, id) as Agent | undefined
          if (!agent || agent === before) continue
          const heard = heardFrom(agent, receivedAt)
          Map.prototype.set.call(state.agents, id, event.replayed ? heard : advanceAgentActiveTime(before, heard, receivedAt))
        }
      }
      processed++
      if (opts.shouldYield?.()) break
    }
  } finally {
    writes?.restore()
  }
  return { state: publish(prev, state, currentTime), processed }
}
