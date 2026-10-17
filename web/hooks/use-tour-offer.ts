'use client'

import { useCallback, useEffect, useState } from 'react'
import { markTourOffered, readTourOffered, shouldOfferTour, type TourOffered } from '@/lib/tour-offer'

interface TourOfferState {
  canStart: boolean
  tourActive: boolean
  guidedDemo: boolean
  immersive: boolean
  presentation: boolean
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * The tour offer of the first launch (#377). Read after mount, so the server render and hydration stay identical.
 * Spent (stored) the first time it shows; full screen and presentation mode hide it without spending it.
 */
export function useTourOffer({ canStart, tourActive, guidedDemo, immersive, presentation }: TourOfferState) {
  const [offered, setOffered] = useState<TourOffered>('unknown')
  useEffect(() => { setOffered(readTourOffered(browserStorage())) }, [])
  const [phase, setPhase] = useState<'waiting' | 'shown' | 'closed'>('waiting')

  useEffect(() => {
    if (phase !== 'waiting' || !shouldOfferTour({ offered, canStart, tourActive, guidedDemo, immersive, presentation })) return
    markTourOffered(browserStorage())
    setPhase('shown')
  }, [phase, offered, canStart, tourActive, guidedDemo, immersive, presentation])

  // A tour started from the legend or the palette answers the offer
  useEffect(() => { if (phase === 'shown' && tourActive) setPhase('closed') }, [phase, tourActive])

  const dismiss = useCallback(() => setPhase('closed'), [])
  return { open: phase === 'shown' && canStart && !tourActive && !immersive && !presentation, dismiss }
}
