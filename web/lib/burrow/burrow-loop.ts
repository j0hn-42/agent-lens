/**
 * Burrow view: the frame loop (no DOM of its own, the timers are given). With motion, one animation step per frame.
 * Under reduced motion or Freeze motion nothing moves, so no animation frame is requested at all: a slow timer follows
 * the agents and draws the resting scene when something changed, and wake() brings it forward after a change.
 */
import { SYNC_INTERVAL_MS } from './burrow-sync'

/** Reduced motion: the scene follows the agents this often (it draws only when something changed) */
const CALM_MS = 2 * SYNC_INTERVAL_MS
/** Reduced motion: delay before the scene follows a change (selection, hover, resize) */
const WAKE_MS = 120

export interface BurrowLoopHost {
  requestFrame(cb: (ts: number) => void): number
  cancelFrame(id: number): void
  setTimer(cb: () => void, ms: number): number
  clearTimer(id: number): void
}

export interface BurrowLoopOptions {
  host: BurrowLoopHost
  /** Read at each frame and each tick: reduced motion or Freeze motion */
  reduced: () => boolean
  /** With motion: one animation step, `dt` seconds since the previous frame (at most 0.1) */
  frame: (dt: number) => void
  /** Reduced motion: follow the agents, draw if something changed */
  calm: () => void
}

export function createBurrowLoop({ host, reduced, frame, calm }: BurrowLoopOptions): { wake: () => void; stop: () => void } {
  let stopped = false
  let raf = 0
  let timer = 0
  /** The pending timer is a wake (due within WAKE_MS): another wake does not postpone it */
  let soon = false
  let last = 0

  const onFrame = (ts: number): void => {
    raf = 0
    if (stopped) return
    if (reduced()) { wake(); return }
    const dt = Math.min(0.1, Math.max(0, (ts - last) / 1000))
    last = ts
    frame(dt)
    if (!stopped && !raf) raf = host.requestFrame(onFrame)
  }
  const onTimer = (): void => {
    timer = 0
    soon = false
    if (stopped) return
    if (!reduced()) { wake(); return }
    calm()
    if (!stopped && !timer) timer = host.setTimer(onTimer, CALM_MS)
  }
  function wake(): void {
    if (stopped) return
    if (reduced()) {
      if (raf) { host.cancelFrame(raf); raf = 0 }
      if (timer && soon) return
      if (timer) host.clearTimer(timer)
      soon = true
      timer = host.setTimer(onTimer, WAKE_MS)
    } else {
      if (timer) { host.clearTimer(timer); timer = 0; soon = false }
      if (!raf) raf = host.requestFrame((ts) => { last = ts; raf = host.requestFrame(onFrame) })
    }
  }

  wake()
  return {
    wake,
    stop(): void {
      stopped = true
      if (raf) host.cancelFrame(raf)
      if (timer) host.clearTimer(timer)
      raf = 0; timer = 0
    },
  }
}
