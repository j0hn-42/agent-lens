// Tiny shared store for the Pair filter so the message feed, the transcript and the timeline stay in sync
// without lifting state into the visualizer root. Module-level on purpose: one visualizer per page.

import { useSyncExternalStore } from 'react'
import { EMPTY_PAIR, makePair, pickPairAgent, samePair, type PairState } from './pair-filter'

let current: PairState = EMPTY_PAIR
const listeners = new Set<() => void>()

function publish(next: PairState) {
  if (samePair(next, current)) return
  current = next
  for (const l of [...listeners]) l()
}

export function getPair(): PairState { return current }
export function setPair(a: string | null | undefined, b: string | null | undefined): void { publish(makePair(a, b)) }
export function pickPair(key: string): void { publish(pickPairAgent(current, key)) }
export function clearPair(): void { publish(EMPTY_PAIR) }

export function subscribePair(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Current shared pair (re-renders on change). */
export function usePairFilter(): PairState {
  return useSyncExternalStore(subscribePair, getPair, () => EMPTY_PAIR)
}
