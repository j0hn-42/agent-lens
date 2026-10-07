'use client'

/**
 * ONE shared clock for freshness (issue #48). It ticks once per FRESHNESS_TICK_MS while someone
 * subscribes and the document is visible. Components never render on the tick itself: they subscribe
 * to a coarse derived value (useFreshnessValue) and React re-renders them only when that value changes.
 * The canvas does not need React at all: it derives freshness per frame from the simulation state.
 */
import { useSyncExternalStore } from 'react'
import { FRESHNESS_TICK_MS } from '../lib/canvas-constants'

export interface FreshnessClock {
  subscribe(listener: () => void): () => void
  /** Time (ms) of the last tick: stable between ticks so it is a valid external-store snapshot input */
  getNow(): number
}

export interface ClockEnv {
  tickMs?: number
  now?: () => number
  isHidden?: () => boolean
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  /** Registers a visibility change listener, returns its remover */
  onVisibilityChange?: (fn: () => void) => () => void
}

function defaultEnv(): Required<ClockEnv> {
  const doc = typeof document !== 'undefined' ? document : undefined
  return {
    tickMs: FRESHNESS_TICK_MS,
    now: () => Date.now(),
    isHidden: () => !!doc && doc.visibilityState === 'hidden',
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
    onVisibilityChange: fn => {
      if (!doc) return () => {}
      doc.addEventListener('visibilitychange', fn)
      return () => doc.removeEventListener('visibilitychange', fn)
    },
  }
}

export function createFreshnessClock(env: ClockEnv = {}): FreshnessClock {
  const e = { ...defaultEnv(), ...env }
  const listeners = new Set<() => void>()
  let lastNow = e.now()
  let handle: unknown = null
  let stopVisibility: (() => void) | null = null

  const tick = () => {
    lastNow = e.now()
    for (const l of [...listeners]) l()
  }
  const startTimer = () => {
    if (handle === null && !e.isHidden()) handle = e.setInterval(tick, e.tickMs)
  }
  const stopTimer = () => {
    if (handle !== null) { e.clearInterval(handle); handle = null }
  }
  const onVisibility = () => {
    if (e.isHidden()) stopTimer()
    else if (listeners.size > 0) {
      // Back in the foreground: catch up at once, then resume
      startTimer()
      tick()
    }
  }

  return {
    getNow: () => lastNow,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        lastNow = e.now()
        stopVisibility = e.onVisibilityChange(onVisibility)
        startTimer()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopTimer()
          stopVisibility?.()
          stopVisibility = null
        }
      }
    },
  }
}

let shared: FreshnessClock | null = null
/** The app-wide clock (created on first use). */
export function getFreshnessClock(): FreshnessClock {
  return (shared ??= createFreshnessClock())
}

/**
 * Subscribe to a value derived from the shared clock. `derive` must return a primitive (string,
 * number, boolean) that only changes when something crosses a threshold: the component then
 * re-renders on that change and never on a plain tick.
 */
export function useFreshnessValue<T extends string | number | boolean>(
  derive: (now: number) => T,
  clock: FreshnessClock = getFreshnessClock(),
): T {
  return useSyncExternalStore(
    clock.subscribe,
    () => derive(clock.getNow()),
    () => derive(clock.getNow()),
  )
}
