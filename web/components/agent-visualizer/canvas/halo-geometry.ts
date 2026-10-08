/**
 * Geometry of the cluster halos (the zones drawn around a session / team / workflow): the smallest circle that
 * wraps the agents of a cluster, and its easing when agents appear, finish or get hidden.
 * Pure: no React, no canvas.
 */

/** A disc to wrap: an agent (centre, drawn radius) */
export interface HaloDisc { x: number; y: number; r: number }
export interface HaloCircle { cx: number; cy: number; r: number }

/**
 * Room an agent takes around its node beyond its drawn radius: its name and state labels sit under the node, so
 * the halo has to leave them inside (world px).
 */
export const HALO_LABEL_ROOM = 22
/** Margin between the outermost agent (with its labels) and the halo edge (world px) */
export const HALO_MARGIN = 26

/** Refinement steps of the centre (each one moves it towards the farthest disc) */
const REFINE_STEPS = 40

/** Radius that wraps every disc from `(cx, cy)` */
function wrapRadius(discs: ReadonlyArray<HaloDisc>, cx: number, cy: number): number {
  let r = 0
  for (const d of discs) r = Math.max(r, Math.hypot(d.x - cx, d.y - cy) + d.r)
  return r
}

/**
 * Smallest-circle fit of `discs` plus `margin`: starts from the middle of their bounding box (the same middle an
 * orchestrator is centred on, #151) and walks the centre towards the farthest disc while that shrinks the circle
 * (Badoiu-Clarkson). Deterministic; the radius always wraps every disc. Undefined without any disc.
 */
export function fitHalo(discs: ReadonlyArray<HaloDisc>, margin: number = HALO_MARGIN): HaloCircle | undefined {
  if (discs.length === 0) return undefined
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const d of discs) {
    minX = Math.min(minX, d.x - d.r); maxX = Math.max(maxX, d.x + d.r)
    minY = Math.min(minY, d.y - d.r); maxY = Math.max(maxY, d.y + d.r)
  }
  let best = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, r: 0 }
  best.r = wrapRadius(discs, best.cx, best.cy)
  let cx = best.cx, cy = best.cy
  for (let i = 1; i <= REFINE_STEPS && discs.length > 1; i++) {
    let far = discs[0], farD = -1
    for (const d of discs) {
      const v = Math.hypot(d.x - cx, d.y - cy) + d.r
      if (v > farD) { farD = v; far = d }
    }
    cx += (far.x - cx) / (i + 1)
    cy += (far.y - cy) / (i + 1)
    const r = wrapRadius(discs, cx, cy)
    if (r < best.r - 1e-9) best = { cx, cy, r }
  }
  return { cx: best.cx, cy: best.cy, r: best.r + margin }
}

/** Share of the remaining gap closed per second by the easing (about 90% in 0.3 s) */
const EASE_RATE = 8

/**
 * Eases the drawn halos towards their fitted circle so a halo that grows or shrinks (an agent appears, finishes or
 * is hidden) never jumps. A cluster seen for the first time starts on its target; one that is gone is forgotten.
 * `snap` (reduced motion) draws the target as it is.
 */
export function createHaloEaser() {
  const shown = new Map<string, HaloCircle>()
  return {
    /** Moves `clusters` (mutated: cx, cy, r) towards their targets; `dt` in seconds */
    apply(clusters: Array<{ key: string } & HaloCircle>, dt: number, snap = false): void {
      const k = snap || !(dt > 0) ? 1 : 1 - Math.exp(-EASE_RATE * Math.min(dt, 0.25))
      const alive = new Set<string>()
      for (const c of clusters) {
        alive.add(c.key)
        const prev = shown.get(c.key)
        if (prev && k < 1) {
          prev.cx += (c.cx - prev.cx) * k
          prev.cy += (c.cy - prev.cy) * k
          prev.r += (c.r - prev.r) * k
        } else shown.set(c.key, { cx: c.cx, cy: c.cy, r: c.r })
        const now = shown.get(c.key)!
        c.cx = now.cx; c.cy = now.cy; c.r = now.r
      }
      for (const key of shown.keys()) if (!alive.has(key)) shown.delete(key)
    },
  }
}
