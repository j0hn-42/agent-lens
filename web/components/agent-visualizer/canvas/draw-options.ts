import { LOD, MIN_VISIBLE_OPACITY } from '../../../lib/canvas-constants'
import type { TeamSummary } from '../../../lib/agent-types'
import type { OverlayPlan } from './label-placement'

/** Options shared by the draw functions. Every field has a safe default. */
export interface DrawOpts {
  /** Reduced motion (OS preference or the "Pause animations" toggle): no ambient/decorative motion. */
  reducedMotion: boolean
  /** Current camera zoom (1 = 100%), used for level of detail. */
  zoom: number
  /** The cost overlay is active (affects the stacked overlay layout above agents). */
  showCost: boolean
  /** The stats overlay is active (affects the stacked overlay layout above agents). */
  showStats: boolean
  /** Several sessions are on screen: agent labels name their session. */
  showSessionLabels?: boolean
  /** Screen-space placement of the text overlays (labels, stats, cost pills, bubbles); absent = draw everything in place */
  plan?: OverlayPlan
  /** Many agents on screen: secondary text is limited to the selected / hovered / focused agent */
  crowded?: boolean
  /** Link messages are drawn as bubbles on the edges: particles carry no text label */
  edgeBubbles?: boolean
  /** Keyboard-focused agent (keeps its secondary text when crowded) */
  focusedAgentId?: string | null
  /** Teams, to tell the lead of a team ('LEAD') from the main agent of a session ('MAIN') */
  teams?: ReadonlyMap<string, Pick<TeamSummary, 'leadSessionId' | 'name'>>
}

export const DEFAULT_DRAW_OPTS: DrawOpts = { reducedMotion: false, zoom: 1, showCost: false, showStats: false, showSessionLabels: false }

export interface LevelOfDetail {
  /** Agent names + state labels */
  labels: boolean
  /** Secondary text: stats, token labels, tool/discovery/bubble text, cost pills */
  details: boolean
}

/** Pure level-of-detail rule: hide text that would fall below a readable size. */
export function lodForZoom(zoom: number): LevelOfDetail {
  return { labels: zoom >= LOD.labelMinZoom, details: zoom >= LOD.detailMinZoom }
}

/** Is an element drawn at this opacity visible enough to be interactive? */
export function isInteractiveOpacity(opacity: number): boolean {
  return opacity >= MIN_VISIBLE_OPACITY
}

export interface FlashLimiter {
  /** Returns true when a flash may be shown at `nowMs`, and records it. */
  allow(nowMs: number): boolean
}

/** Global limiter: at most `maxPerSecond` flashes in any sliding 1s window (WCAG 2.3.1). */
export function createFlashLimiter(maxPerSecond: number): FlashLimiter {
  const stamps: number[] = []
  return {
    allow(nowMs: number) {
      while (stamps.length > 0 && nowMs - stamps[0] >= 1000) stamps.shift()
      if (stamps.length >= maxPerSecond) return false
      stamps.push(nowMs)
      return true
    },
  }
}
