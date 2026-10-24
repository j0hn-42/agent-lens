/**
 * What a replayed or imported history (app start, opening a large workflow) shows: the state it leads to,
 * not the animations of the past. Its events must not make hundreds of particles fly, agents pop in and cards
 * fade in all at once while the catch-up runs. Live events keep their animation.
 */
import type { SimulationEvent } from '../../lib/agent-types'
import type { MutableEventState } from './process-event'

/** A replayed or imported event: it describes the past, nothing is happening now */
export function isHistoricalEvent(event: Pick<SimulationEvent, 'replayed' | 'imported'>): boolean {
  return event.replayed === true || event.imported === true
}

/** Drops the particles an event just created (the ones before `kept` were there already). */
export function dropNewParticles(state: MutableEventState, kept: number): void {
  if (state.particles.length > kept) state.particles.length = kept
}

/**
 * Entry animations of the agents, tool cards and edges snapped to their end: visible at once, or gone when a
 * finished call has nothing left to show (the same values a seek snaps to). Writes go through the Map
 * prototype so the agents stay "untouched" for the freshness stamping of the batch.
 */
export function settleEntryAnimations(state: MutableEventState): void {
  for (const [id, agent] of state.agents) {
    if (agent.state === 'complete' || (agent.opacity >= 1 && agent.scale >= 1)) continue
    Map.prototype.set.call(state.agents, id, { ...agent, opacity: 1, scale: 1 })
  }
  for (const [id, tc] of state.toolCalls) {
    const opacity = tc.state === 'running' ? 1 : 0
    if (tc.opacity !== opacity) state.toolCalls.set(id, { ...tc, opacity })
  }
  for (let i = 0; i < state.edges.length; i++) {
    const edge = state.edges[i]
    if (edge.opacity >= 1) continue
    const target = state.toolCalls.get(edge.to)
    if (target && target.opacity <= 0) continue
    state.edges[i] = { ...edge, opacity: 1 }
  }
}
