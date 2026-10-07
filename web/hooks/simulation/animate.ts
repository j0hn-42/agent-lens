import type { SimulationState } from './types'
import {
  TOOL_MIN_DISPLAY_S, TOOL_EXPIRY_S,
  DISCOVERY_HOLD_S, DISCOVERY_LERP_SPEED,
  BUBBLE_VISIBLE_S, MOCK_END_BUFFER_S,
  ANIM_SPEED, isExpiryHeld,
} from '../../lib/canvas-constants'
import { ARCHIVED_OPACITY } from './archive'
import { settleToolCall } from '../../lib/tool-lifecycle'
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
    let timeAlive = agent.timeAlive
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
    if (agent.state !== 'complete') { timeAlive += deltaTime; updated = true }
    // Prune expired message bubbles
    // (skipped while the agent is hovered/focused, playback is paused, or "never hide" is on)
    if (messageBubbles.length > 0 && !isExpiryHeld('agent', id)) {
      const pruned = messageBubbles.filter(b => currentTime - b.time <= BUBBLE_VISIBLE_S)
      if (pruned.length !== messageBubbles.length) { messageBubbles = pruned; updated = true }
    }
    if (updated) {
      if (newAgents === agents) newAgents = new Map(agents)
      newAgents.set(id, { ...agent, opacity, scale, timeAlive, messageBubbles })
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

function animateToolCalls(toolCalls: SimulationState['toolCalls'], deltaTime: number, newTime: number, expiryS: number): SimulationState['toolCalls'] {
  let newToolCalls = toolCalls
  for (const [id, current] of toolCalls) {
    // A call whose end never came is closed as expired (never silently dropped or shown as done)
    const tc = settleToolCall(current, newTime, expiryS)
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

/** An agent whose last running call expired is no longer "calling a tool": nothing proves what it does now. */
export function releaseAgentsOfExpiredCalls(
  agents: SimulationState['agents'],
  before: SimulationState['toolCalls'],
  after: SimulationState['toolCalls'],
): SimulationState['agents'] {
  if (before === after) return agents
  let next = agents
  for (const [id, tc] of after) {
    if (tc.state !== 'expired' || before.get(id)?.state !== 'running') continue
    const agent = next.get(tc.agentId)
    if (!agent || agent.state !== 'tool_calling') continue
    let stillBusy = false
    for (const other of after.values()) {
      if (other.agentId === tc.agentId && other.state === 'running') { stillBusy = true; break }
    }
    if (stillBusy) continue
    if (next === agents) next = new Map(agents)
    next.set(tc.agentId, { ...agent, state: 'idle', currentTool: undefined })
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

  // Remove orphaned edges whose endpoints no longer exist
  const beforeLen = filteredEdges.length
  filteredEdges = filteredEdges.filter(e => {
    const fromExists = newAgents.has(e.from)
    if (!fromExists) return false
    const toExists = newAgents.has(e.to) || newToolCalls.has(e.to)
    return toExists
  })
  return { agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges }
}

function animateDiscoveries(discoveries: SimulationState['discoveries'], deltaTime: number, newTime: number): SimulationState['discoveries'] {
  return discoveries
    .map(d => {
      const age = newTime - d.timestamp
      const lerpT = Math.min(1, deltaTime * DISCOVERY_LERP_SPEED)
      const x = d.x + (d.targetX - d.x) * lerpT
      const y = d.y + (d.targetY - d.y) * lerpT
      if (age < DISCOVERY_HOLD_S || isExpiryHeld('discovery', d.id)) {
        return { ...d, x, y, opacity: Math.min(0.9, d.opacity + deltaTime * ANIM_SPEED.discoveryFadeIn) }
      } else {
        return { ...d, x, y, opacity: Math.max(0, d.opacity - deltaTime * ANIM_SPEED.discoveryFadeOut) }
      }
    })
    .filter(d => d.opacity > 0)
}

function animateParticles(particles: SimulationState['particles'], deltaTime: number, speed: number): SimulationState['particles'] {
  const particleSpeed = ANIM_SPEED.particleSpeed * speed
  return particles.map(p => {
    if (p.type === 'return' || p.type === 'tool_return')
      return { ...p, progress: Math.max(0, p.progress - deltaTime * particleSpeed) }
    return { ...p, progress: Math.min(1, p.progress + deltaTime * particleSpeed) }
  }).filter(p => {
    if ((p.type === 'return' || p.type === 'tool_return') && p.progress <= 0) return false
    if ((p.type === 'dispatch' || p.type === 'tool_call' || p.type === 'message') && p.progress >= 1) return false
    return true
  })
}

export function computeNextFrame(prev: SimulationState, deltaTime: number, newTime: number, maxT: number, currentState: SimulationState, options: AnimateOptions): SimulationState {
      // Record dispatch/return particles and tool calls the moment they exist (before expiry removes them)
      recordFrame(a11yRecorder, { particles: currentState.particles, edges: currentState.edges, agents: currentState.agents, toolCalls: currentState.toolCalls })
      const newToolCallsRaw = animateToolCalls(currentState.toolCalls, deltaTime, newTime, options.toolExpiryS ?? TOOL_EXPIRY_S)
      const newAgentsRaw = animateAgents(
        releaseAgentsOfExpiredCalls(currentState.agents, currentState.toolCalls, newToolCallsRaw),
        deltaTime, currentState.currentTime,
      )
      const newEdgesRaw = animateEdges(currentState.edges, deltaTime)

      const { agents: newAgents, toolCalls: newToolCalls, edges: filteredEdges } =
        cleanupFaded(newAgentsRaw, newToolCallsRaw, newEdgesRaw, currentState.agents, currentState.toolCalls)

      const newDiscoveries = animateDiscoveries(currentState.discoveries, deltaTime, newTime)
      const newParticles = animateParticles(currentState.particles, deltaTime, options.speed ?? currentState.speed)

      // Stop playback when mock scenario ends (user can restart manually)
      if (options.useMockData && currentState.eventIndex >= options.mockScenarioLength && newTime > options.mockScenarioEndTime + MOCK_END_BUFFER_S) {
        return {
          ...currentState, currentTime: newTime, eventIndex: currentState.eventIndex,
          agents: newAgents, toolCalls: newToolCalls,
          particles: newParticles, edges: filteredEdges,
          discoveries: newDiscoveries,
          maxTimeReached: maxT,
          isPlaying: false,
        }
      }

      return {
        ...currentState, currentTime: newTime, eventIndex: currentState.eventIndex,
        agents: newAgents, toolCalls: newToolCalls,
        particles: newParticles, edges: filteredEdges,
        discoveries: newDiscoveries,
        maxTimeReached: maxT,
      }
}
