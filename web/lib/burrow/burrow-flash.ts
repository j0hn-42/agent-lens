/**
 * Burrow view: the room reacts at the instant a tool call is received. An object of the room of the call lights up
 * briefly, wherever the animal is (it may still be on its way, or stay in the room of most of its calls): a screen of
 * the office, a shelf or the open book of the library, the furnace or the vice of the workshop, a flask or the
 * chalkboard of the laboratory, the telephone for a dispatch, the lantern beside the front door for a question to the
 * user. One flash is one received call (burrow-sync's `received`: never a call already there when the view opened),
 * and there is none in the still scene of reduced motion or Freeze motion. Scene pixels of the 560 x 315 picture.
 */
import type { BurrowWorkshopId } from './burrow-types'
import type { ReceivedCall } from './burrow-sync'
import { BURROW_TELEPHONE } from './burrow-telephone'

type Pt = { readonly x: number; readonly y: number }

/** The objects that light up, per room: their centre in the picture */
const BURROW_FLASH_SPOTS: Readonly<Record<BurrowWorkshopId, readonly Pt[]>> = {
  office: [{ x: 78, y: 54 }, { x: 115, y: 52 }, { x: 142, y: 55 }],                 // the three screens
  library: [{ x: 441, y: 45 }, { x: 467, y: 45 }, { x: 490, y: 45 }, { x: 502, y: 72 }],   // the shelves, the open book
  workshop: [{ x: 145, y: 203 }, { x: 115, y: 196 }],                                // the furnace's window, the vice
  lab: [{ x: 446, y: 196 }, { x: 456, y: 197 }, { x: 503, y: 183 }],                  // two flasks, the chalkboard
  phone: [{ x: BURROW_TELEPHONE.cx, y: BURROW_TELEPHONE.y + 6 }],                     // the telephone's dial
  door: [{ x: 145, y: 39 }],                                                           // the lantern beside the front door
}

/** How long a flash lasts (seconds of the scene's clock) */
const FLASH_SECONDS = 0.8

export interface BurrowFlash { x: number; y: number; t0: number }

function hash(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** One flash per received call, at an object of its room picked from the call's id; none in the still scene */
export function flashesOf(received: readonly ReceivedCall[], still: boolean, clock: number): BurrowFlash[] {
  if (still) return []
  const out: BurrowFlash[] = []
  for (const c of received) {
    const spots = BURROW_FLASH_SPOTS[c.room as BurrowWorkshopId]
    if (!spots?.length) continue
    const p = spots[hash(c.id) % spots.length]
    out.push({ x: p.x, y: p.y, t0: clock })
  }
  return out
}

/** Brightness of a flash `age` seconds after it started: up at once, then fading out; 0 before and once over */
export function flashAlpha(age: number): number {
  if (age < 0 || age >= FLASH_SECONDS) return 0
  const rise = 0.08
  return age < rise ? age / rise : 1 - (age - rise) / (FLASH_SECONDS - rise)
}
