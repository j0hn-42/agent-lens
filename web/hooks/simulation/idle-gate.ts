import type { SimulationState } from './types'
import { settleToolCall } from '../../lib/tool-lifecycle'
import {
  TOOL_MIN_DISPLAY_S, DISCOVERY_HOLD_S, BUBBLE_VISIBLE_S, MOCK_END_BUFFER_S, isExpiryHeld,
} from '../../lib/canvas-constants'
import { ARCHIVED_OPACITY } from './archive'

/**
 * Idle gate of the simulation loop (#660). The draw gate (#216) spares the drawing of a still scene; this one spares
 * the simulation step itself: a frame with nothing to do (no event to play, nothing moving or fading, no deadline of
 * the clock reached, layout at rest) only advances the clock. It mirrors computeNextFrame rule for rule: a frame it
 * skips is one that would have left every collection of the state as it was (scripts/sim-idle-gate.test.ts checks
 * both against each other). It never delays an event: anything queued or due makes the frame run.
 */
export interface IdleGateInput {
  /** Events waiting outside the state: the external queue handed by the bridge, the catch-up backlog */
  queued: boolean
  /** The force layout would move nothing (ForceLayout.isSettled); true when there is no layout */
  layoutSettled: boolean
  /** Seconds a running call may last without an observed end before it expires */
  toolExpiryS: number
  /** Demo playback: the scenario's length, its last event time and the time of its next event (undefined when none is left) */
  mock?: { length: number; endTime: number; nextTime: number | undefined }
}

/** Frames computed / skipped by the live loop since the start (read by the hook test and the micro-bench) */
export const simLoopStats = { computed: 0, skipped: 0 }

/** True when the frame that would bring `state` to `newTime` has nothing to do but advance the clock. */
export function isSimulationIdle(state: SimulationState, newTime: number, input: IdleGateInput): boolean {
  if (input.queued || !input.layoutSettled) return false
  if (state.particles.length > 0) return false

  // Events: the demo scenario, or the log entries a seek back left ahead of the clock
  if (input.mock) {
    if (input.mock.nextTime !== undefined && input.mock.nextTime <= newTime) return false
    // The end of the scenario stops the playback (computeNextFrame)
    if (state.eventIndex >= input.mock.length && newTime > input.mock.endTime + MOCK_END_BUFFER_S) return false
  } else {
    const next = state.eventLog[state.eventIndex]
    if (next && next.time <= newTime) return false
  }

  for (const e of state.edges) {
    if (e.opacity < 1) return false
    // An edge whose end is gone is removed (cleanupFaded)
    if (!state.agents.has(e.from) || (!state.agents.has(e.to) && !state.toolCalls.has(e.to))) return false
  }

  const now = state.currentTime
  for (const [id, a] of state.agents) {
    if (a.state !== 'complete') {
      if (a.opacity < 1 || a.scale < 1) return false
    } else if (!a.isMain) {
      const floor = a.archived ? ARCHIVED_OPACITY : 0
      if (a.opacity !== floor || a.scale > 0.8) return false
      // A faded sub-agent that is not archived is removed (cleanupFaded)
      if (!a.archived && a.opacity <= 0) return false
    }
    // Bubbles are pruned against the clock of the frame before (animateAgents)
    if (a.messageBubbles.length > 0 && !isExpiryHeld('agent', id)) {
      for (const b of a.messageBubbles) if (now - b.time > BUBBLE_VISIBLE_S) return false
    }
  }

  for (const [id, tc] of state.toolCalls) {
    // A running call past its expiry delay is closed now
    if (settleToolCall(tc, newTime, input.toolExpiryS, state.agents) !== tc) return false
    if (tc.opacity <= 0) return false
    if (tc.state === 'running' || isExpiryHeld('tool', id) || newTime - (tc.completeTime ?? 0) < TOOL_MIN_DISPLAY_S) {
      if (tc.opacity < 1) return false
    } else {
      return false
    }
  }

  for (const d of state.discoveries) {
    if (d.x !== d.targetX || d.y !== d.targetY) return false
    if (newTime - d.timestamp < DISCOVERY_HOLD_S || isExpiryHeld('discovery', d.id)) {
      if (d.opacity !== 0.9) return false
    } else {
      return false
    }
  }
  return true
}

/** The skipped frame: the clock advances (a received event is stamped and played against it), nothing else changes. */
export function idleFrame(state: SimulationState, newTime: number, maxTimeReached: number): SimulationState {
  return { ...state, currentTime: newTime, maxTimeReached }
}
