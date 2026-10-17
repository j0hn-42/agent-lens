/**
 * Tour offered on the first launch (#377). Pure (no React): what is stored, and when the offer shows.
 * It is offered once per browser: the mark is written when the offer first shows. A storage that cannot be read
 * (private window, blocked site data) cannot remember it, so the offer is not made rather than made on every visit.
 */

const TOUR_OFFER_STORAGE_KEY = 'agent-lens:tour-offered'

export type TourOffered = 'yes' | 'no' | 'unknown'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readTourOffered(storage: StorageLike | null | undefined): TourOffered {
  if (!storage) return 'unknown'
  try {
    return storage.getItem(TOUR_OFFER_STORAGE_KEY) === null ? 'no' : 'yes'
  } catch {
    return 'unknown'
  }
}

export function markTourOffered(storage: StorageLike | null | undefined): void {
  try {
    storage?.setItem(TOUR_OFFER_STORAGE_KEY, '1')
  } catch {
    // Not remembered: readTourOffered reads the same storage as unknown, so nothing is offered again
  }
}

export interface TourOfferInput {
  offered: TourOffered
  /** The legend offers a tour now (something is on screen to explain, no tour running) */
  canStart: boolean
  tourActive: boolean
  /** ?scenario=guided starts its own tour */
  guidedDemo: boolean
  immersive: boolean
  presentation: boolean
  /** Under 600 px wide the card would cover the canvas controls: not offered there (the legend button stays) */
  narrow: boolean
}

export function shouldOfferTour(i: TourOfferInput): boolean {
  return i.offered === 'no' && i.canStart && !i.tourActive && !i.guidedDemo && !i.immersive && !i.presentation && !i.narrow
}
