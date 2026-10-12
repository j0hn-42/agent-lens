import type { Transform } from './camera-fit'

/** The part of the world that is on screen, in world units (margin included). */
export interface ViewRect { minX: number; minY: number; maxX: number; maxY: number }

/** Screen margin around the canvas inside which elements are still drawn (px): soft edges, glows, fast pans. */
export const CULL_MARGIN_PX = 96

/** Half-extent (world units) of everything an agent paints around its centre: ring, glow, label, stats, context bar. */
export const AGENT_CULL_EXTENT = 150
/** Half-extent of a particle with its comet trail and label. */
export const PARTICLE_CULL_EXTENT = 100
/** Slack around the control polygon of an edge: stroke width plus the active glow. */
export const EDGE_CULL_EXTENT = 16

/**
 * World rectangle visible through `transform` on a `width` x `height` canvas, grown by `marginPx`.
 * Undefined when there is nothing sensible to cull against (no size yet): callers then draw everything.
 */
export function viewRectFor(transform: Transform, width: number, height: number, marginPx: number = CULL_MARGIN_PX): ViewRect | undefined {
  if (!(width > 0) || !(height > 0) || !(transform.scale > 0)) return undefined
  const s = transform.scale
  return {
    minX: (-marginPx - transform.x) / s,
    minY: (-marginPx - transform.y) / s,
    maxX: (width + marginPx - transform.x) / s,
    maxY: (height + marginPx - transform.y) / s,
  }
}

/** Does the box overlap the view? Without a view everything is visible. */
export function boxInView(view: ViewRect | undefined, minX: number, minY: number, maxX: number, maxY: number): boolean {
  if (!view) return true
  return maxX >= view.minX && minX <= view.maxX && maxY >= view.minY && minY <= view.maxY
}

/** Does the square of half-size `extent` around a point overlap the view? */
export function pointInView(view: ViewRect | undefined, x: number, y: number, extent: number): boolean {
  if (!view) return true
  return x + extent >= view.minX && x - extent <= view.maxX && y + extent >= view.minY && y - extent <= view.maxY
}

/** Does the bounding box of a cubic Bezier (its control polygon, grown by the stroke slack) overlap the view? */
export function edgeInView(
  view: ViewRect | undefined,
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number,
): boolean {
  if (!view) return true
  return boxInView(
    view,
    Math.min(x0, x1, x2, x3) - EDGE_CULL_EXTENT, Math.min(y0, y1, y2, y3) - EDGE_CULL_EXTENT,
    Math.max(x0, x1, x2, x3) + EDGE_CULL_EXTENT, Math.max(y0, y1, y2, y3) + EDGE_CULL_EXTENT,
  )
}
