import { useCallback, useEffect, useState } from 'react'
import type { TourStep } from '@/lib/guided-steps'
import { INACTIVE_TOUR, startTour, nextStep, prevStep, goToStep, exitTour, type TourState } from '@/lib/guided-tour-nav'

interface Options {
  steps: readonly TourStep[]
  /** Pauses the scenario and seeks to a time (the seek of the playback bar) */
  seek: (time: number) => void
  play: () => void
}

export function useGuidedTour({ steps, seek, play }: Options) {
  const [state, setState] = useState<TourState>(INACTIVE_TOUR)
  const step = state.active ? steps[state.index] ?? null : null

  // Each step change of the demo: pause and replay the scenario up to the step time.
  // A step without a time (tour of a real session) leaves the live scene alone.
  useEffect(() => {
    if (step && 'time' in step && typeof step.time === 'number') seek(step.time)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seek is a fresh closure each render; only the step must re-trigger
  }, [step])

  const start = useCallback(() => setState(startTour()), [])
  const next = useCallback(() => setState(s => nextStep(s, steps.length)), [steps.length])
  const prev = useCallback(() => setState(s => prevStep(s, steps.length)), [steps.length])
  const goTo = useCallback((i: number) => setState(s => goToStep(s, i, steps.length)), [steps.length])
  const exit = useCallback(() => { setState(exitTour()); play() }, [play])

  return { active: state.active, index: state.index, step, start, next, prev, goTo, exit }
}
