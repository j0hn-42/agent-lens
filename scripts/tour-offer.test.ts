import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { markTourOffered, readTourOffered, shouldOfferTour } from '../web/lib/tour-offer'

// The tour is offered once, on the first launch (#377): remembered in this browser, never when it cannot be remembered

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v) },
    data,
  }
}
const TOUR_OFFER_STORAGE_KEY = 'agent-lens:tour-offered' // the key docs/reading-the-ui/legend-and-tour.md names
const throwing = {
  getItem: () => { throw new Error('blocked') },
  setItem: () => { throw new Error('blocked') },
}

test('tour offer: nothing stored reads as not offered yet; a stored mark as offered', () => {
  assert.equal(readTourOffered(memory()), 'no')
  assert.equal(readTourOffered(memory({ [TOUR_OFFER_STORAGE_KEY]: '1' })), 'yes')
})

test('tour offer: a storage that cannot be read is unknown, and is never written over', () => {
  assert.equal(readTourOffered(throwing), 'unknown')
  assert.equal(readTourOffered(null), 'unknown')
  assert.doesNotThrow(() => markTourOffered(throwing))
  assert.doesNotThrow(() => markTourOffered(null))
})

test('tour offer: marking it stores the key once', () => {
  const s = memory()
  markTourOffered(s)
  assert.equal(s.data.get(TOUR_OFFER_STORAGE_KEY), '1')
  assert.equal(readTourOffered(s), 'yes')
})

const base = { offered: 'no' as const, canStart: true, tourActive: false, guidedDemo: false, immersive: false, presentation: false, narrow: false }

test('tour offer: shown on a first launch while a tour can start', () => {
  assert.equal(shouldOfferTour(base), true)
})

test('tour offer: not shown once offered, or when that cannot be remembered', () => {
  assert.equal(shouldOfferTour({ ...base, offered: 'yes' }), false)
  assert.equal(shouldOfferTour({ ...base, offered: 'unknown' }), false)
})

test('tour offer: not shown while no tour can start, one runs, in the guided demo, full screen or presentation mode', () => {
  assert.equal(shouldOfferTour({ ...base, canStart: false }), false)
  assert.equal(shouldOfferTour({ ...base, tourActive: true }), false)
  assert.equal(shouldOfferTour({ ...base, guidedDemo: true }), false)
  assert.equal(shouldOfferTour({ ...base, immersive: true }), false)
  assert.equal(shouldOfferTour({ ...base, presentation: true }), false)
})

test('tour offer: not shown under 600 px wide, where it would cover the canvas controls', () => {
  assert.equal(shouldOfferTour({ ...base, narrow: true }), false)
})
