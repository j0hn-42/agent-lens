'use client'

import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { useGuidedTour } from '@/hooks/use-guided-tour'
import type { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { GUIDED_STEPS, type TourStep } from '@/lib/guided-steps'
import { buildLiveTourSteps } from '@/lib/live-tour'
import { EMPTY_PRESENCE, type LegendPresence } from '@/lib/legend-presence'
import type { TourBridge } from '@/components/agent-visualizer/guided-tour-context'

interface TourControllerInput {
  seek: (time: number) => void
  play: () => void
  /** ?scenario=guided on the demo data: the scripted tour runs, nowhere else */
  isGuidedDemo: boolean
  frameRef: ReturnType<typeof useAgentSimulation>['frameRef']
  /** The tour shows the idle and finished agents its steps talk about, without touching the preference */
  setTourShowsInactive: (show: boolean) => void
}

/**
 * Guided tour. Demo (?scenario=guided): step times only match the guided scenario, so it runs nowhere else.
 * Real session (#244): the steps are built from what the canvas proves on screen when the tour starts; they have
 * no scenario time, so the tour neither seeks nor pauses the live scene.
 */
export function useTourController({ seek, play, isGuidedDemo, frameRef, setTourShowsInactive }: TourControllerInput) {
  const [liveSteps, setLiveSteps] = useState<readonly TourStep[] | null>(null)
  const tour = useGuidedTour({
    steps: liveSteps ?? GUIDED_STEPS,
    seek: liveSteps ? () => {} : seek,
    play: liveSteps ? () => {} : play,
  })
  const canvasToScreenRef = useRef<TourBridge['canvasToScreenRef']['current']>(null)
  // What the canvas proves on screen now (reported by the canvas, read when the live tour starts and by its steps)
  const [presence, setPresence] = useState<LegendPresence>(EMPTY_PRESENCE)
  const presenceRef = useRef(presence)
  presenceRef.current = presence
  // Set after mount (IS_GUIDED_DEMO reads the URL, unknown to the server render): keeps hydration identical.
  // A real source taking over ends the tour: its step times do not match the real event log.
  const [guidedDemo, setGuidedDemo] = useState(false)
  useEffect(() => {
    setGuidedDemo(isGuidedDemo)
    if (isGuidedDemo) tour.start()
    else if (tour.active) tour.exit()
  }, [isGuidedDemo])   // eslint-disable-line react-hooks/exhaustive-deps
  const startLiveTour = useCallback(() => {
    const steps = buildLiveTourSteps(presenceRef.current)
    if (steps.length === 0) return
    setLiveSteps(steps)
    tour.start()
  }, [tour.start])   // eslint-disable-line react-hooks/exhaustive-deps
  const exitTour = useCallback(() => { tour.exit(); setLiveSteps(null) }, [tour.exit])   // eslint-disable-line react-hooks/exhaustive-deps
  const canStartLiveTour = !guidedDemo && presence.entries.length > 0
  const startTour = tour.active ? undefined : guidedDemo ? tour.start : canStartLiveTour ? startLiveTour : undefined
  const startTourLabel = guidedDemo ? undefined : 'Tour this session'
  const tourBridge = useMemo(
    () => ({ legendOpen: Boolean(tour.step?.opensLegend), legendShowAll: guidedDemo, canvasToScreenRef, startTour, startTourLabel, reportPresence: setPresence }),
    [tour.step, guidedDemo, startTour, startTourLabel],
  )
  // A live step is a snapshot: when what it explains left the scene, the card says so instead of going on as if
  const tourStale = Boolean(liveSteps && tour.step && !tour.step.covers.every(id => presence.entries.includes(id)))
  const getTourAgents = useCallback(() => frameRef.current.agents, [frameRef])
  useEffect(() => { setTourShowsInactive(tour.active && !liveSteps) }, [tour.active, liveSteps, setTourShowsInactive])

  return { tour, steps: liveSteps ?? GUIDED_STEPS, tourBridge, tourStale, getTourAgents, exitTour }
}
