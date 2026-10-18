/**
 * Hit rectangles (world coordinates) produced by the overlay plan of the last drawn frame, read by
 * hit-testing: cluster labels, edge bubbles and the count chips that replace crowded agent bubbles.
 * A mutable module singleton (like `expiryHold`) written once per frame by the canvas.
 */
import type { Rect } from './label-placement'
import type { LevelOfDetail } from './draw-options'

export interface OverlayHitState {
  clusterLabels: Map<string, Rect>
  edgeBubbles: Map<string, Rect>
  collapsedBubbles: Map<string, Rect>
}

export const overlayHits: OverlayHitState = {
  clusterLabels: new Map(),
  edgeBubbles: new Map(),
  collapsedBubbles: new Map(),
}

export function setOverlayHits(next: OverlayHitState): void {
  overlayHits.clusterLabels = next.clusterLabels
  overlayHits.edgeBubbles = next.edgeBubbles
  overlayHits.collapsedBubbles = next.collapsedBubbles
}

/**
 * Level of detail of the last drawn frame, hysteresis included: hit-testing sizes what the frame enlarged
 * (discovery cards held at LOD.minTextPx, #378) as it was drawn. Written once per frame by the canvas.
 */
export const frameLevel: { lod: LevelOfDetail | undefined } = { lod: undefined }

export function clearOverlayHits(): void {
  overlayHits.clusterLabels = new Map()
  overlayHits.edgeBubbles = new Map()
  overlayHits.collapsedBubbles = new Map()
}
