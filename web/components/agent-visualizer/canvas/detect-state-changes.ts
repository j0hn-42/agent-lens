import type { Agent, ToolCallNode } from '@/lib/agent-types'
import { FX } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import type { VisualEffect } from './draw-effects'

/** A semantic state transition detected between frames. */
export type StateTransition =
  | { kind: 'agent_spawn'; id: string; name: string }
  | { kind: 'agent_complete'; id: string; name: string }
  | { kind: 'agent_error'; id: string; name: string }
  | { kind: 'agent_waiting_permission'; id: string; name: string }
  | { kind: 'tool_start'; id: string; name: string }
  | { kind: 'tool_complete'; id: string; name: string }
  | { kind: 'tool_error'; id: string; name: string }
  /** A teammate changed activity ('working' | 'idle' | 'done') */
  | { kind: 'agent_activity'; id: string; name: string; activity: string }
  /** A new message travelled on a link */
  | { kind: 'message_sent'; id: string; name: string; from: string; to: string }

/**
 * Compare previous and current agent/tool states and return both visual effects
 * and semantic transitions.
 *
 * This is a pure function: it reads the previous state maps, computes results,
 * and returns the effects, transitions, and updated state maps.
 *
 * Both the canvas (for visuals) and the audio system (for sounds) consume
 * these results, keeping detection logic in a single place.
 */
export function detectStateChanges(
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
  prevAgentStates: Map<string, string>,
  prevToolStates: Map<string, string>,
): {
  effects: VisualEffect[]
  transitions: StateTransition[]
  newAgentStates: Map<string, string>
  newToolStates: Map<string, string>
} {
  const effects: VisualEffect[] = []
  const transitions: StateTransition[] = []
  const newAgentStates = new Map<string, string>()
  const newToolStates = new Map<string, string>()

  for (const [id, agent] of agents) {
    newAgentStates.set(id, agent.state)
    const oldState = prevAgentStates.get(id)

    // Spawn: new agent (wasn't in prev)
    if (!oldState) {
      transitions.push({ kind: 'agent_spawn', id, name: agent.name })
      if (agent.opacity < 0.5) {
        effects.push({
          type: 'spawn', x: agent.x, y: agent.y,
          color: COLORS.holoBase, age: 0, duration: FX.spawnDuration,
        })
      }
    }

    // Complete: just became complete
    if (oldState && oldState !== 'complete' && agent.state === 'complete') {
      transitions.push({ kind: 'agent_complete', id, name: agent.name })
      effects.push({
        type: 'complete', x: agent.x, y: agent.y,
        color: COLORS.complete, age: 0, duration: FX.completeDuration,
      })
    }

    // Error / permission request: just entered that state (announced to screen readers)
    if (oldState && oldState !== agent.state) {
      if (agent.state === 'error') transitions.push({ kind: 'agent_error', id, name: agent.name })
      else if (agent.state === 'waiting_permission') transitions.push({ kind: 'agent_waiting_permission', id, name: agent.name })
    }
  }

  for (const [id, tool] of toolCalls) {
    newToolStates.set(id, tool.state)
    const oldState = prevToolStates.get(id)

    // Tool just started running
    if (!oldState && tool.state === 'running') {
      transitions.push({ kind: 'tool_start', id, name: tool.toolName })
    }

    // Tool just completed
    if (oldState === 'running' && tool.state === 'complete') {
      transitions.push({ kind: 'tool_complete', id, name: tool.toolName })
      const particleData: VisualEffect['particles'] = []
      for (let i = 0; i < FX.shatterCount; i++) {
        particleData.push({
          angle: (i / FX.shatterCount) * Math.PI * 2 + Math.random() * 0.5,
          speed: FX.shatterSpeed.min + Math.random() * FX.shatterSpeed.range,
          size: FX.shatterSize.min + Math.random() * FX.shatterSize.range,
        })
      }
      effects.push({
        type: 'shatter', x: tool.x, y: tool.y,
        color: COLORS.return, age: 0, duration: FX.shatterDuration,
        particles: particleData,
      })
    }

    // Tool errored
    if (oldState === 'running' && tool.state === 'error') {
      transitions.push({ kind: 'tool_error', id, name: tool.toolName })
    }
  }

  return { effects, transitions, newAgentStates, newToolStates }
}
