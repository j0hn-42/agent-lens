/**
 * Decides, once per animation frame, whether the canvas has to be redrawn (#216).
 *
 * A scene that does not move (settled simulation, still camera, nothing animated) is redrawn only when its
 * stamp changes or after the interval of its mode; the rest of the frames are skipped. Nothing here invents
 * state: a skipped frame leaves the last drawn frame on screen, and the stamp covers everything that moves.
 */

/** Calm scene (nothing animated, not under reduced motion): 10 fps at most. */
export const CALM_FRAME_MS = 100
/** Reduced motion or paused animations: redraw on change, and at least this often so clocks and expiries stay true. */
export const FROZEN_FRAME_MS = 250
/** After a pointer, wheel or key interaction the loop runs at full rate for this long, so the UI answers at once. */
export const INTERACTION_HOLD_MS = 1000

export interface GateInput {
  /** requestAnimationFrame timestamp (ms) */
  now: number
  /** Cheap fingerprint of everything that moves or changes the picture; a different value forces a draw */
  stamp: number
  /** Reduced motion (OS preference or paused animations): nothing ambient moves */
  reducedMotion: boolean
  /** Something is animated right now: active agent, particle in flight, effect (decorative: stops under reduced motion) */
  animating: boolean
  /** The camera moves or a drag is under way (functional: kept under reduced motion too). Optional, false by default */
  moving?: boolean
}

export interface DrawGate {
  /** True when this frame has to be drawn. Call once per frame. */
  shouldDraw(input: GateInput): boolean
  /** An interaction happened: draw at full rate for INTERACTION_HOLD_MS from the next frame (the frame clock is the one of shouldDraw) */
  wake(): void
  /** Force the next frame to draw (resize, visibility change) */
  invalidate(): void
  readonly drawn: number
  readonly skipped: number
}

export function createDrawGate(): DrawGate {
  let lastStamp = NaN
  let lastDraw = -Infinity
  let awakeUntil = -Infinity
  let forced = true
  let wakePending = false
  let drawn = 0
  let skipped = 0
  return {
    shouldDraw({ now, stamp, reducedMotion, animating, moving }) {
      if (wakePending) { wakePending = false; awakeUntil = now + INTERACTION_HOLD_MS }
      const interval = reducedMotion ? FROZEN_FRAME_MS : CALM_FRAME_MS
      const draw = forced || stamp !== lastStamp || moving || now < awakeUntil || (animating && !reducedMotion) || now - lastDraw >= interval
      if (!draw) { skipped++; return false }
      forced = false
      lastStamp = stamp
      lastDraw = now
      drawn++
      return true
    },
    wake() { wakePending = true },
    invalidate() { forced = true },
    get drawn() { return drawn },
    get skipped() { return skipped },
  }
}

/** Fold a number into a running fingerprint (FNV-style, 32 bits, allocation free). */
export function mixStamp(h: number, v: number): number {
  const n = Number.isFinite(v) ? Math.round(v * 8) : 0
  return (Math.imul(h ^ (n | 0), 16777619) ^ ((n / 4294967296) | 0)) >>> 0
}

/** Fold a string into a fingerprint. */
export function mixStampStr(h: number, s: string | null | undefined): number {
  if (!s) return mixStamp(h, 0)
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  return h
}
