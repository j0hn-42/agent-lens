/**
 * Event-time recorder for the accessible DOM mirror. The simulation step calls
 * `recordFrame` for every frame, so dispatch / return particles (alive 0.2-0.8 s) and
 * short-lived tool calls are captured at the moment they exist, not by a polling timer.
 * Pure module state, no React: unit-testable under node:test.
 */
import type { Agent, ToolCallNode, Particle, Edge } from '../../../lib/agent-types'
import { updateCommHistory, updateToolHistory, type CommEntry, type ToolHistoryEntry } from './a11y-model'

export interface A11yRecorder {
  comms: Map<string, CommEntry>
  tools: Map<string, ToolHistoryEntry>
  /** Bumped whenever a new entry or a changed tool entry was recorded */
  version: number
}

export function createRecorder(): A11yRecorder {
  return { comms: new Map(), tools: new Map(), version: 0 }
}

export function recordFrame(
  rec: A11yRecorder,
  frame: { particles: Particle[]; edges: Edge[]; agents: Map<string, Agent>; toolCalls: Map<string, ToolCallNode> },
): void {
  const commSize = rec.comms.size
  const lastComm = lastKey(rec.comms)
  updateCommHistory(rec.comms, frame.particles, frame.edges, frame.agents)
  let changed = rec.comms.size !== commSize || lastKey(rec.comms) !== lastComm

  for (const [id, tc] of frame.toolCalls) {
    const prev = rec.tools.get(id)
    if (!prev || prev.state !== tc.state) { changed = true; break }
  }
  updateToolHistory(rec.tools, frame.toolCalls)
  if (changed) rec.version++
}

export function resetRecorder(rec: A11yRecorder): void {
  rec.comms.clear()
  rec.tools.clear()
  rec.version++
}

function lastKey(m: Map<string, unknown>): string | undefined {
  let last: string | undefined
  for (const k of m.keys()) last = k
  return last
}

/** Shared instance written by the animation step, read by the canvas snapshot. */
export const a11yRecorder: A11yRecorder = createRecorder()
