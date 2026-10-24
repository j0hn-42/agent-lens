'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { markTourOffered, readTourOffered, shouldOfferTour, type TourOffered } from '@/lib/tour-offer'

interface TourOfferState {
  canStart: boolean
  tourActive: boolean
  guidedDemo: boolean
  immersive: boolean
  presentation: boolean
  /** A permission card is on screen: a pending decision comes before an optional offer */
  permissionShown?: boolean
}

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const NARROW_QUERY = '(max-width: 599.98px)'
const narrowList = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : null)
function subscribeNarrow(onChange: () => void) {
  const mql = narrowList()
  mql?.addEventListener('change', onChange)
  return () => mql?.removeEventListener('change', onChange)
}
const isNarrow = () => narrowList()?.matches ?? false

/**
 * The tour offer of the first launch (#377). Read after mount, so the server render and hydration stay identical.
 * Spent (stored) the first time it shows; full screen, presentation mode and a width under 600 px hide it without
 * spending it. So does a permission card on screen: the pending decision comes first (its buttons would be covered
 * on a short window), and the offer comes back, still unanswered, once no card is shown.
 */
export function useTourOffer({ canStart, tourActive, guidedDemo, immersive, presentation, permissionShown = false }: TourOfferState) {
  const [offered, setOffered] = useState<TourOffered>('unknown')
  useEffect(() => { setOffered(readTourOffered(browserStorage())) }, [])
  const [phase, setPhase] = useState<'waiting' | 'shown' | 'closed'>('waiting')
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false)

  useEffect(() => {
    if (phase !== 'waiting' || permissionShown || !shouldOfferTour({ offered, canStart, tourActive, guidedDemo, immersive, presentation, narrow })) return
    markTourOffered(browserStorage())
    setPhase('shown')
  }, [phase, offered, canStart, tourActive, guidedDemo, immersive, presentation, narrow, permissionShown])

  // A tour started from the legend or the palette answers the offer
  useEffect(() => { if (phase === 'shown' && tourActive) setPhase('closed') }, [phase, tourActive])

  const dismiss = useCallback(() => setPhase('closed'), [])
  return { open: phase === 'shown' && canStart && !tourActive && !immersive && !presentation && !narrow && !permissionShown, dismiss }
}
