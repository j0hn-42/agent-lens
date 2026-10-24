import type { SimulationState } from './types'
import {
  TOOL_MIN_DISPLAY_S, TOOL_EXPIRY_S,
  DISCOVERY_HOLD_S, DISCOVERY_LERP_SPEED,
  BUBBLE_VISIBLE_S, MOCK_END_BUFFER_S,
  ANIM_SPEED, isExpiryHeld,
} from '../../lib/canvas-constants'
import { ARCHIVED_OPACITY } from './archive'
import { settleToolCall } from '../../lib/tool-lifecycle'
import { EXPIRED_LABEL_SUFFIX } from '../../lib/ui-glossary'
import { a11yRecorder, recordFrame } from '../../components/agent-visualizer/canvas/a11y-recorder'

export interface AnimateOptions {
  useMockData: boolean
  mockScenarioLength: number
  mockScenarioEndTime: number
  /** Playback speed to animate with (already forced to 1 outside review); defaults to the state's speed */
  speed?: number
  /** Seconds a tool call may run without an observed end before it expires; defaults to TOOL_EXPIRY_S */
  toolExpiryS?: number
}

function animateAgents(agents: SimulationState['agents'], deltaTime: number, currentTime: number): SimulationState['agents'] {
  let newAgents = agents
  for (const [id, agent] of agents) {
    let updated = false
    let opacity = agent.opacity
    let scale = agent.scale
    let messageBubbles = agent.messageBubbles

    if (agent.state !== 'complete' && opacity < 1) { opacity = Math.min(1, opacity + deltaTime * ANIM_SPEED.agentFadeIn); updated = true }
    if (agent.state !== 'complete' && scale < 1) { scale = Math.min(1, scale + deltaTime * ANIM_SPEED.agentScaleIn); updated = true }
    if (agent.state === 'complete' && !agent.isMain) {
      // Archived agents are kept: they fade to a reduced opacity instead of vanishing
      const floor = agent.archived ? ARCHIVED_OPACITY : 0
      if (opacity > floor) { opacity = Math.max(floor, opacity - deltaTime * ANIM_SPEED.agentFadeOut); updated = true }
      else if (opacity < floor) { opacity = Math.min(floor, opacity + deltaTime * ANIM_SPEED.agentFadeIn); updated = true }
      if (scale > 0.8) { scale = Math.max(0.8, scale - deltaTime * ANIM_SPEED.agentScaleOut); updated = true }
    }
    // The age is not written here: it is read from the clock where it is shown (agentAge, #660), so an agent at rest is not copied
    // Prune expired message bubbles
    // (skipped while the agent is hovered/focused, playback is paused, or "never hide" is on)
    if (messageBubbles.length > 0 && !isExpiryHeld('agent', id)) {
      const pruned = messageBubbles.filter(b => currentTime - b.time <= BUBBLE_VISIBLE_S)
      if (pruned.length !== messageBubbles.length) { messageBubbles = pruned; updated = true }
    }
    if (updated) {
      if (newAgents === agents) newAgents = new Map(agents)
      newAgents.set(id, { ...agent, opacity, scale, messageBubbles })
    }
  }
  return newAgents
}

function animateEdges(edges: SimulationState['edges'], deltaTime: number): SimulationState['edges'] {
  if (edges.some(e => e.opacity < 1)) {
    return edges.map(e =>
      e.opacity < 1 ? { ...e, opacity: Math.min(1, e.opacity + deltaTime * ANIM_SPEED.edgeFadeIn) } : e
    )
  }
  return edges
}

function animateToolCalls(toolCalls: SimulationState['toolCalls'], agents: SimulationState['agents'], deltaTime: number, newTime: number, expiryS: number): SimulationState['toolCalls'] {
  let newToolCalls = toolCalls
  for (const [id, current] of toolCalls) {
    // A call whose end never came is closed as expired (never silently dropped or shown as done)
    const tc = settleToolCall(current, newTime, expiryS, agents)
    let newOpacity = tc.opacity
    // Held cards (hovered/focused, paused, "never hide") never start fading out
    const held = isExpiryHeld('tool', id)
    if (tc.state === 'running') {
      newOpacity = Math.min(1, tc.opacity + deltaTime * ANIM_SPEED.toolFadeIn)
    } else {
      const timeSinceComplete = newTime - (tc.completeTime ?? 0)
      if (held || timeSinceComplete < TOOL_MIN_DISPLAY_S) {
        newOpacity = Math.min(1, tc.opacity + deltaTime * ANIM_SPEED.toolFadeIn)
      } else {
        newOpacity = Math.max(0, tc.opacity - deltaTime * ANIM_SPEED.toolFadeOut)
      }
    }
    if (tc !== current || newOpacity !== tc.opacity) {
      if (newToolCalls === toolCalls) newToolCalls = new Map(toolCalls)
      newToolCalls.set(id, { ...tc, opacity: newOpacity })
    }
  }
  return newToolCalls
}

/**
 * Closes the timeline block of every call that just expired: it ends at the deadline and says its end was
 * not observed, instead of growing as "ongoing" forever. The agent's own state is left alone: nothing
 * proves it stopped working (a sub-agent or a long command may still be going).
 */
export function closeExpiredTimelineBlocks(
  entries: SimulationState['timelineEntries'],
  before: SimulationState['toolCalls'],
  after: SimulationState['toolCalls'],
): SimulationState['timelineEntries'] {
  if (before === after) return entries
  let next = entries
  for (const [id, tc] of after) {
    if (tc.state !== 'expired' || before.get(id)?.state !== 'running') continue
    const entry = next.get(tc.agentId)
    if (!entry) continue
    const at = tc.completeTime ?? tc.startTime
    const idx = entry.blocks.findIndex(b =>
      b.type === 'tool_call' && b.endTime === undefined && b.startTime === tc.startTime && b.label.startsWith(`${tc.toolName}:`))
    if (idx < 0) continue
    const blocks = entry.blocks.slice()
    blocks[idx] = { ...blocks[idx], endTime: at, label: `${blocks[idx].label} ${EXPIRED_LABEL_SUFFIX}` }
    if (next === entries) next = new Map(entries)
    next.set(tc.agentId, { ...entry, blocks })
  }
  return next
}

function cleanupFaded(
  agents: SimulationState['agents'],
  toolCalls: SimulationState['toolCalls'],
  edges: SimulationState['edges'],
  originalAgents: SimulationState['agents'],
  originalToolCalls: SimulationState['toolCalls'],
): { agents: SimulationState['agents']; toolCalls: SimulationState['toolCalls']; edges: SimulationState['edges'] } {
  let newAgents = agents
  let newToolCalls = toolCalls
  let filteredEdges = edges

  // Cleanup faded agents (completed sub-agents) and their edges
  const fadedAgentIds: string[] = []
  for (const [id, agent] of newAgents) {
    if (!agent.isMain && !agent.archived && agent.state === 'complete' && agent.opacity <= 0) {
      fadedAgentIds.push(id)
    }
  }
  if (fadedAgentIds.length > 0) {
    if (newAgents === originalAgents) newAgents = new Map(originalAgents)
    const fadedSet = new Set(fadedAgentIds)
    for (const id of fadedAgentIds) newAgents.delete(id)
    filteredEdges = filteredEdges.filter(e => !fadedSet.has(e.from) && !fadedSet.has(e.to))
  }

  // Cleanup faded tool calls (opacity <= 0) and their edges
  const fadedToolIds: string[] = []
  for (const [id, tc] of newToolCalls) {
    if (tc.opacity <= 0) fadedToolIds.push(id)
  }
  if (fadedToolIds.length > 0) {
    if (newToolCalls === originalToolCalls) newToolCalls = new Map(originalToolCalls)
    const fadedSet = new Set(fadedToolIds)
    for (const id of fadedToolIds) newToolCalls.delete(id)
    filteredEdges = filteredEdges.filter(e => !(e.type === 'tool' && fadedSet.has(e.to)))
  }

  // Remove orphaned edges whose endpoints no longer exist (the same array when none is: #660)
  const exists = (e: SimulationState['edges'][number]) => newAgents.has(e.from) && (newAgents.has(e.to) || newToolCalls.has(e.to))
  if (!filteredEdges.every(exists)) filteredEdges = filteredEdges.filter(exists)
  return { agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges }
}

/** A discovery this close (world px) to its resting place is put on it: it then stops moving for good (#660) */
const DISCOVERY_SNAP_PX = 0.01

/** Same array when no discovery moves, fades or leaves (#660): an array at rest keeps the caches of the draw loop */
function animateDiscoveries(discoveries: SimulationState['discoveries'], deltaTime: number, newTime: number): SimulationState['discoveries'] {
  if (discoveries.length === 0) return discoveries
  let changed = false
  const out: SimulationState['discoveries'] = []
  for (const d of discoveries) {
    const age = newTime - d.timestamp
    const lerpT = Math.min(1, deltaTime * DISCOVERY_LERP_SPEED)
    let x = d.x + (d.targetX - d.x) * lerpT
    let y = d.y + (d.targetY - d.y) * lerpT
    if (Math.abs(d.targetX - x) <= DISCOVERY_SNAP_PX) x = d.targetX
    if (Math.abs(d.targetY - y) <= DISCOVERY_SNAP_PX) y = d.targetY
    const opacity = age < DISCOVERY_HOLD_S || isExpiryHeld('discovery', d.id)
      ? Math.min(0.9, d.opacity + deltaTime * ANIM_SPEED.discoveryFadeIn)
      : Math.max(0, d.opacity - deltaTime * ANIM_SPEED.discoveryFadeOut)
    if (opacity <= 0) { changed = true; continue }
    if (x === d.x && y === d.y && opacity === d.opacity) { out.push(d); continue }
    changed = true
    out.push({ ...d, x, y, opacity })
  }
  return changed ? out : discoveries
}

function isReturn(p: SimulationState['particles'][number]): boolean {
  return p.type === 'return' || p.type === 'tool_return'
}

/** Same array when there is no particle (they always travel otherwise); arrived particles leave (#660) */
function animateParticles(particles: SimulationState['particles'], deltaTime: number, speed: number): SimulationState['particles'] {
  if (particles.length === 0) return particles
  const particleSpeed = ANIM_SPEED.particleSpeed * speed
  let changed = false
  const out: SimulationState['particles'] = []
  for (const p of particles) {
    const progress = isReturn(p)
      ? Math.max(0, p.progress - deltaTime * particleSpeed)
      : Math.min(1, p.progress + deltaTime * particleSpeed)
    if (isReturn(p) ? progress <= 0 : progress >= 1) { changed = true; continue }
    if (progress === p.progress) { out.push(p); continue }
    changed = true
    out.push({ ...p, progress })
  }
  return changed ? out : particles
}

export function computeNextFrame(prev: SimulationState, deltaTime: number, newTime: number, maxT: number, currentState: SimulationState, options: AnimateOptions): SimulationState {
      // Record dispatch/return particles and tool calls the moment they exist (before expiry removes them)
      recordFrame(a11yRecorder, { particles: currentState.particles, edges: currentState.edges, agents: currentState.agents, toolCalls: currentState.toolCalls })
      const newToolCallsRaw = animateToolCalls(currentState.toolCalls, currentState.agents, deltaTime, newTime, options.toolExpiryS ?? TOOL_EXPIRY_S)
      const timelineEntries = closeExpiredTimelineBlocks(currentState.timelineEntries, currentState.toolCalls, newToolCallsRaw)
      const newAgentsRaw = animateAgents(currentState.agents, deltaTime, currentState.currentTime)
      const newEdgesRaw = animateEdges(currentState.edges, deltaTime)

      const { agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges } =
        cleanupFaded(newAgentsRaw, newToolCallsRaw, newEdgesRaw, currentState.agents, currentState.toolCalls)

      const newDiscoveries = animateDiscoveries(currentState.discoveries, deltaTime, newTime)
      const newParticles = animateParticles(currentState.particles, deltaTime, options.speed ?? currentState.speed)

      // Stop playback when mock scenario ends (user can restart manually)
      if (options.useMockData && currentState.eventIndex >= options.mockScenarioLength && newTime > options.mockScenarioEndTime + MOCK_END_BUFFER_S) {
        return {
          ...currentState, currentTime: newTime, eventIndex: currentState.eventIndex,
          agents: newAgents, toolCalls: newToolCalls, timelineEntries,
          particles: newParticles, edges: filteredEdges,
          discoveries: newDiscoveries,
          maxTimeReached: maxT,
          isPlaying: false,
        }
      }

      return {
        ...currentState, currentTime: newTime, eventIndex: currentState.eventIndex,
        agents: newAgents, toolCalls: newToolCalls, timelineEntries,
        particles: newParticles, edges: filteredEdges,
        discoveries: newDiscoveries,
        maxTimeReached: maxT,
      }
}
