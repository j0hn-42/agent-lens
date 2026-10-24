import type { Agent } from './agent-types'

/**
 * Age of an agent on the simulation clock (#383), read when it is shown rather than written into every agent at
 * every frame (#660): from its spawn to `now`, or to its completion once it is complete (a seek before that
 * completion shows its age then). Never negative: after Clear history the clock restarts at 0 and nothing proves an
 * age until an event brings the session time back.
 */
export function agentAge(agent: Pick<Agent, 'state' | 'spawnTime' | 'completeTime'>, now: number): number {
  const end = agent.state === 'complete' ? Math.min(agent.completeTime ?? now, now) : now
  return Math.max(0, end - agent.spawnTime)
}
