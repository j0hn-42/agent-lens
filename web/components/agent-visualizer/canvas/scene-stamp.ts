import type { Agent, ToolCallNode } from '../../../lib/agent-types'
import type { Transform } from './camera-fit'
import { mixStamp, mixStampStr } from './draw-gate'

/** Everything that decides whether the picture changes, gathered without allocation. */
export interface SceneStampInput {
  agents: Iterable<Agent>
  toolCalls: Iterable<ToolCallNode>
  particles: number
  edges: number
  discoveries: number
  effects: number
  transform: Transform
  width: number
  height: number
  dpr: number
  /** Counter bumped when React hands the canvas new props */
  epoch: number
  /** Identity of the selection, hover, focus and toggles (null / undefined / boolean are allowed) */
  keys: ReadonlyArray<string | boolean | null | undefined>
}

/** Cheap fingerprint of the scene: a different value means the next frame may look different. */
export function sceneStamp(i: SceneStampInput): number {
  let h = 2166136261
  h = mixStamp(h, i.transform.x)
  h = mixStamp(h, i.transform.y)
  h = mixStamp(h, i.transform.scale * 1000)
  h = mixStamp(h, i.width)
  h = mixStamp(h, i.height)
  h = mixStamp(h, i.dpr * 100)
  h = mixStamp(h, i.epoch)
  h = mixStamp(h, i.particles)
  h = mixStamp(h, i.edges)
  h = mixStamp(h, i.discoveries)
  h = mixStamp(h, i.effects)
  for (const k of i.keys) h = typeof k === 'boolean' ? mixStamp(h, k ? 1 : 2) : mixStampStr(h, k)
  for (const a of i.agents) {
    h = mixStamp(h, a.x)
    h = mixStamp(h, a.y)
    h = mixStamp(h, a.opacity * 100)
    h = mixStamp(h, a.scale * 100)
    h = mixStamp(h, a.tokensUsed)
    h = mixStamp(h, a.toolCalls)
    h = mixStamp(h, a.messageBubbles.length)
    h = mixStampStr(h, a.state)
    h = mixStampStr(h, a.activity)
    h = mixStamp(h, a.archived ? 1 : 0)
  }
  for (const t of i.toolCalls) {
    h = mixStamp(h, t.x)
    h = mixStamp(h, t.y)
    h = mixStamp(h, t.opacity * 100)
    h = mixStampStr(h, t.state)
    h = mixStamp(h, t.tokenCost ?? -1)
  }
  return h
}

/** Does something move on its own (pulse, orbit, comet, effect)? Then the loop keeps its full frame rate. */
export function sceneAnimating(agents: Iterable<Agent>, toolCalls: Iterable<ToolCallNode>, particles: number, effects: number): boolean {
  if (particles > 0 || effects > 0) return true
  for (const a of agents) {
    if (a.state === 'thinking' || a.state === 'tool_calling' || a.state === 'waiting_permission') return true
  }
  for (const t of toolCalls) if (t.state === 'running') return true
  return false
}
