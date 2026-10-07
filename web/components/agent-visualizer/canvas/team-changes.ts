/**
 * Detection of teammate activity changes and new link messages (live-region announcements).
 * Separate from detect-state-changes.ts so it stays free of "@/" runtime imports (node:test).
 */
import type { Agent } from '../../../lib/agent-types'
import type { AgentLink } from '../../../hooks/simulation/types'
import type { StateTransition } from './detect-state-changes'
import { resolveAgentRef } from './link-geometry'
import { cleanText, teammateActivity } from './team-style'

// ─── Teams: teammate activity and link messages ──────────────────────────────

/** Previous values compared by `detectTeamChanges`. */
export interface TeamPrev {
  activity: Map<string, string>
  linkCounts: Map<string, number>
  /** False until the first pass: history that already exists is recorded, never announced */
  primed: boolean
}

export function createTeamPrev(): TeamPrev {
  return { activity: new Map(), linkCounts: new Map(), primed: false }
}

/** Most message announcements produced for one link in one pass (a burst is not read out in full) */
const MAX_MESSAGES_PER_LINK = 2

/**
 * Detect teammate activity changes and new link messages between two passes.
 * Pure: returns the transitions and the updated previous-state (a new object).
 */
export function detectTeamChanges(
  agents: Map<string, Agent>,
  links: Map<string, AgentLink> | undefined,
  prev: TeamPrev,
): { transitions: StateTransition[]; next: TeamPrev } {
  const transitions: StateTransition[] = []
  const activity = new Map<string, string>()
  const linkCounts = new Map<string, number>()

  for (const [id, agent] of agents) {
    const current = teammateActivity(agent)
    if (!current) continue
    activity.set(id, current)
    const before = prev.activity.get(id)
    // A teammate that finished (state 'complete') is already announced as "Agent X completed" by the state
    // detection: a second "X is done" would read the same event twice
    const alreadyCompleted = current === 'done' && agent.state === 'complete'
    if (prev.primed && before && before !== current && !alreadyCompleted) {
      transitions.push({ kind: 'agent_activity', id, name: cleanText(agent.name, 80), activity: current })
    }
  }

  if (links) {
    for (const [id, link] of links) {
      const count = link.messages.length + (link.dropped || 0)
      linkCounts.set(id, count)
      const before = prev.linkCounts.get(id) ?? 0
      if (!prev.primed || count <= before) continue
      const fresh = Math.min(count - before, link.messages.length, MAX_MESSAGES_PER_LINK)
      for (let i = link.messages.length - fresh; i < link.messages.length; i++) {
        const m = link.messages[i]
        const nameOf = (ref: string | undefined) => {
          const key = resolveAgentRef(ref ?? '', link.sessionId, agents)
          return cleanText(key ? agents.get(key)?.name : ref, 80) || 'agent'
        }
        const from = nameOf(m.from ?? link.from)
        const to = nameOf(m.to ?? link.to)
        transitions.push({ kind: 'message_sent', id: `${id}#${m.id}`, name: from, from, to })
      }
    }
  }

  return { transitions, next: { activity, linkCounts, primed: true } }
}
