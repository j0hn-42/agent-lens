import { LOD, AGENT_DRAW } from '../../../lib/canvas-constants'
import type { TeamSummary } from '../../../lib/agent-types'
import type { OverlayPlan } from './label-placement'
import type { ViewRect } from './view-cull'
import type { ThemeId } from '../../../lib/theme-tokens'

/** Options shared by the draw functions. Every field has a safe default. */
export interface DrawOpts {
  /** Reduced motion (OS preference or the "Freeze motion" toggle): no ambient/decorative motion. */
  reducedMotion: boolean
  /** Current camera zoom (1 = 100%), used for level of detail. */
  zoom: number
  /** Level of detail of this frame, with hysteresis (see lodForZoom); absent = derived from `zoom` */
  lod?: LevelOfDetail
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
  /** Visible part of the world (margin included): agents, tool cards, edges and particles outside it are not drawn. Absent = draw everything */
  view?: ViewRect
  /** Teams, to tell the lead of a team ('LEAD') from the main agent of a session ('MAIN') */
  teams?: ReadonlyMap<string, Pick<TeamSummary, 'leadSessionId' | 'name'>>
  /** Presentation mode (#245): free text (names, arguments, results, messages) is drawn as bullets; numbers, states and tool names are kept */
  maskText?: boolean
  /** Theme of the scene (#381): agent states (absent = the default theme), labels, links, halos, cards and grid (absent = the neon scene) */
  theme?: ThemeId
  /** Loop / repeat mark per agent id (#377, lib/repeat-marks): a badge on the node. Absent = no badge */
  repeatMarks?: ReadonlyMap<string, { kind: 'loop' | 'repeated' }>
}

export const DEFAULT_DRAW_OPTS: DrawOpts = { reducedMotion: false, zoom: 1, showCost: false, showStats: false, showSessionLabels: false }

export interface LevelOfDetail {
  /** Agent names + state labels */
  labels: boolean
  /** Secondary overlays held at LOD.minTextPx: token labels, link bubbles, and the stats box and cost pill the user turned on (#378) */
  details: boolean
  /** Tool-card and message-bubble text; false = card icon and bubble count chip (#378) */
  cardText: boolean
  /** Secondary text that follows the zoom: context %, discovery text, particle labels, phase and halo labels (#378) */
  detailText: boolean
}

/**
 * Pure level-of-detail rule: hide text that would fall below a readable size. With the level of the
 * previous frame, a shown level is kept down to LOD.hysteresis under its threshold (no blinking).
 */
export function lodForZoom(zoom: number, previous?: LevelOfDetail): LevelOfDetail {
  const keep = (threshold: number, wasShown: boolean | undefined) => zoom >= (wasShown ? threshold * (1 - LOD.hysteresis) : threshold)
  return {
    labels: keep(LOD.labelMinZoom, previous?.labels),
    details: keep(LOD.detailMinZoom, previous?.details),
    cardText: keep(LOD.cardTextMinZoom, previous?.cardText),
    detailText: keep(LOD.detailTextMinZoom, previous?.detailText),
  }
}

/**
 * Factor that holds a text drawn at `worldPx` world px at LOD.minTextPx on screen: 1 where it already
 * reaches that size, more below (the hysteresis band of the level that shows it). Never under 1.
 */
export function textHoldScale(worldPx: number, zoom: number): number {
  if (!(zoom > 0) || !(worldPx > 0)) return 1
  return Math.max(1, LOD.minTextPx / (worldPx * zoom))
}

/**
 * Factor a discovery card is drawn at: enlarged to hold its 11 px text at LOD.minTextPx in the hysteresis
 * band of detailText, 1 elsewhere. Shared by the draw code, the hit test and the focus ring (#378).
 */
export function discoveryCardScale(opts: Pick<DrawOpts, 'zoom' | 'lod'>): number {
  return lodOf(opts).detailText ? textHoldScale(11, opts.zoom) : 1
}

/** Level of detail of a frame: the one the draw loop computed (with hysteresis), else the plain rule. */
export function lodOf(opts: Pick<DrawOpts, 'zoom' | 'lod'>): LevelOfDetail {
  return opts.lod ?? lodForZoom(opts.zoom)
}

/**
 * Factor applied to an agent label (and the context bar under it) so that its text is never smaller
 * than LOD.minTextPx on screen: 1 from the zoom where the label font reaches that size, more below.
 */
export function labelScaleForZoom(zoom: number): number {
  return textHoldScale(AGENT_DRAW.labelFontSize, zoom)
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
