import { useEffect, useRef, type RefObject } from 'react'
import type { SimulationState, AgentLink } from '@/hooks/simulation/types'
import type { Agent } from '@/lib/agent-types'
import { visibleAgents } from '@/lib/inactive-agents'
import type { AnnounceLevel } from '@/lib/ui-preferences'
import type { AnnouncementItem } from '@/components/agent-visualizer/canvas/a11y-model'
import { useCanvasStateEffects } from './use-canvas-state-effects'
import type { CanvasDrawProps } from './use-canvas-draw-props'

/** How often the burrow looks for state changes to announce: independent of its drawing, so the art may still be loading */
const BURROW_ANNOUNCE_INTERVAL_MS = 200

interface BurrowAnnouncementsDeps {
  simulationRef: RefObject<SimulationState>
  announceLevel: AnnounceLevel
  hideInactive: boolean
  selectedAgentId: string | null
  links?: Map<string, AgentLink>
}

// No transient effects are drawn by the burrow: the shared detector is told motion is reduced, so it queues none.
const NO_EFFECTS = { current: true }

/**
 * Live announcements of the Burrow view: the node graph's own detector (useCanvasStateEffects), fed with the agents
 * the burrow shows (the same 'Show: active' filter, the selected agent kept), so a screen reader hears the same
 * text at the same announcement level whichever view is on (#379).
 */
export function useBurrowAnnouncements({ simulationRef, announceLevel, hideInactive, selectedAgentId, links }: BurrowAnnouncementsDeps): AnnouncementItem[] {
  const announceLevelRef = useRef<AnnounceLevel>(announceLevel)
  announceLevelRef.current = announceLevel
  const linksPropRef = useRef(links)
  linksPropRef.current = links
  const live = useRef({ hideInactive, selectedAgentId })
  live.current = { hideInactive, selectedAgentId }
  // Only `agents` is read by the detector
  const drawPropsRef = useRef({ agents: new Map<string, Agent>() } as unknown as CanvasDrawProps)

  const { announcements, detectStateChanges } = useCanvasStateEffects({
    simulationRef, drawPropsRef, reducedMotionRef: NO_EFFECTS, linksPropRef, announceLevelRef,
  })

  useEffect(() => {
    // The first look is a baseline: agents already there when the burrow opens are not read as just started
    let primed = false
    const tick = (): void => {
      const sim = simulationRef.current
      if (!sim) return
      drawPropsRef.current.agents = visibleAgents(sim.agents, live.current.hideInactive, [live.current.selectedAgentId])
      detectStateChanges({ silent: !primed })
      primed = true
    }
    tick()
    const id = window.setInterval(tick, BURROW_ANNOUNCE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [simulationRef, detectStateChanges])

  return announcements
}
