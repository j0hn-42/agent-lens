/**
 * Hit rectangles (world coordinates) produced by the overlay plan of the last drawn frame, read by
 * hit-testing: cluster labels, edge bubbles and the count chips that replace crowded agent bubbles.
 * A mutable module singleton (like `expiryHold`) written once per frame by the canvas.
 */
import type { Rect } from './label-placement'

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

export function clearOverlayHits(): void {
  overlayHits.clusterLabels = new Map()
  overlayHits.edgeBubbles = new Map()
  overlayHits.collapsedBubbles = new Map()
}
