/**
 * Vertical stacking of the overlays drawn above an agent (context %, stats box, cost pill)
 * so they never overlap. All values are distances ABOVE the top of the node (y - r), in world px.
 */
export interface OverlayLayoutInput {
  /** The context percentage label is drawn (main agent, high usage) */
  hasPercent: boolean
  showStats: boolean
  showCost: boolean
}

export interface OverlayLayout {
  /** Distance from the node top up to the TOP edge of the stats box, or null when hidden */
  statsTop: number | null
  /** Distance from the node top up to the TOP edge of the cost pill, or null when hidden */
  costTop: number | null
}

export const OVERLAY_METRICS = {
  /** Gap between the node edge and the first overlay */
  baseGap: 6,
  /** Height reserved by the context percentage label (11px text + gap) */
  percentH: 18,
  statsH: 20,
  costPillH: 20,
  /** Space reserved under the cost pill for the mini bar (3px + 3px gap) */
  costBarH: 6,
  gap: 4,
} as const

export function computeOverlayLayout({ hasPercent, showStats, showCost }: OverlayLayoutInput): OverlayLayout {
  const M = OVERLAY_METRICS
  let cursor = M.baseGap + (hasPercent ? M.percentH : 0)
  let statsTop: number | null = null
  let costTop: number | null = null
  if (showStats) {
    cursor += M.statsH
    statsTop = cursor
    cursor += M.gap
  }
  if (showCost) {
    // The mini bar sits between the pill and the node, so reserve it first.
    cursor += M.costBarH + M.costPillH
    costTop = cursor
  }
  return { statsTop, costTop }
}
