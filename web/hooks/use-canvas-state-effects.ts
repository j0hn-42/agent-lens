import { useRef, useState, useCallback, type MutableRefObject, type RefObject } from 'react'
import type { SimulationState, AgentLink } from '@/hooks/simulation/types'
import { FLASH_MAX_PER_SECOND } from '@/lib/canvas-constants'
import {
  type VisualEffect,
  detectStateChanges as detectStateChangesPure,
  detectTeamChanges, createTeamPrev, type TeamPrev,
  createFlashLimiter, enqueueAnnouncements, createAnnouncementQueue,
  type AnnouncementItem, type AnnouncementQueue,
} from '@/components/agent-visualizer/canvas/index'
import type { CanvasDrawProps } from './use-canvas-draw-props'

interface StateEffectsDeps {
  simulationRef: RefObject<SimulationState>
  drawPropsRef: MutableRefObject<CanvasDrawProps>
  reducedMotionRef: MutableRefObject<boolean>
  linksPropRef: MutableRefObject<Map<string, AgentLink> | undefined>
}

/**
 * State changes of agents and tool calls: spawns transient visual effects (none under reduced
 * motion, flashes rate-limited) and feeds the live-region announcements.
 */
export function useCanvasStateEffects({ simulationRef, drawPropsRef, reducedMotionRef, linksPropRef }: StateEffectsDeps) {
  const effectsRef = useRef<VisualEffect[]>([])
  const prevAgentStatesRef = useRef<Map<string, string>>(new Map())
  const prevToolStatesRef = useRef<Map<string, string>>(new Map())
  const flashLimiterRef = useRef(createFlashLimiter(FLASH_MAX_PER_SECOND))
  const teamPrevRef = useRef<TeamPrev>(createTeamPrev())
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([])
  const announcementsRef = useRef<AnnouncementQueue>(createAnnouncementQueue())

  const detectStateChanges = useCallback(() => {
    const { agents } = drawPropsRef.current
    // States come from the whole simulation, only the shown agents are announced: expanding a
    // branch reveals agents that did not just start.
    const sim = simulationRef.current
    const { effects, transitions, newAgentStates, newToolStates } = detectStateChangesPure(
      sim.agents, sim.toolCalls,
      prevAgentStatesRef.current, prevToolStatesRef.current,
      agents,
    )
    if (!reducedMotionRef.current) {
      // Global flash limiter: at most FLASH_MAX_PER_SECOND bright flashes per second
      for (const fx of effects) {
        if ((fx.type === 'spawn' || fx.type === 'complete') && !flashLimiterRef.current.allow(performance.now())) {
          fx.noFlash = true
        }
      }
      effectsRef.current.push(...effects)
    } else {
      // Reduced motion: state changes are instant, no transient effects
      effectsRef.current.length = 0
    }
    prevAgentStatesRef.current = newAgentStates
    prevToolStatesRef.current = newToolStates

    // Teammate activity changes ("<name> is idle") and new link messages ("<from> sent a message to <to>")
    const team = detectTeamChanges(agents, linksPropRef.current ?? simulationRef.current.links, teamPrevRef.current)
    teamPrevRef.current = team.next
    transitions.push(...team.transitions)

    if (transitions.length > 0) {
      const next = enqueueAnnouncements(announcementsRef.current, transitions)
      if (next !== announcementsRef.current) {
        announcementsRef.current = next
        setAnnouncements(next.items)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the other deps are refs
  }, [simulationRef])

  return { effectsRef, announcements, detectStateChanges }
}
