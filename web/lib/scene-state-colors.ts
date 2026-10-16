/**
 * Agent state colours of the canvas: the one part of the scene that follows the theme (#381).
 *
 * Everything else the canvas draws reads the frozen neon scene palette (lib/colors.ts). The state of an agent (the ring and glow of
 * its node, the scene glow behind the active agent, the legend's swatch) is painted with the colour the panels give that
 * state in the theme, so one state has one colour on every surface. The theme is explicit: callers pass it. The draw loop
 * reads the active theme once per frame with `sceneTheme()` and hands it to the draw functions in their options; the
 * legend takes it from `useTheme()`.
 *
 * Built from the static token table (`paletteFor(id)`), the same values the generated themes.css gives the panels.
 * Pure apart from `sceneTheme()` (which reads data-theme on the document, the default theme without a DOM).
 */

import type { AgentState } from './agent-types'
import { paletteFor } from './theme-palette'
import { currentThemeId } from './theme-dom'
import type { ThemeId } from './theme-tokens'

type StateColors = Readonly<Record<AgentState, string>>

const cache = new Map<ThemeId, StateColors>()

/** The seven agent state colours of a theme (cached: the draw loop asks for them every frame). */
export function sceneStateColors(theme: ThemeId): StateColors {
  let colors = cache.get(theme)
  if (!colors) {
    const p = paletteFor(theme)
    colors = Object.freeze({
      idle: p.idle,
      thinking: p.thinking,
      tool_calling: p.tool_calling,
      complete: p.complete,
      error: p.error,
      paused: p.paused,
      waiting_permission: p.waiting_permission,
    })
    cache.set(theme, colors)
  }
  return colors
}

/** Colour of one agent state on the canvas in a theme (#rrggbb: the canvas appends an alpha to it). */
export function sceneStateColor(state: AgentState, theme: ThemeId): string {
  return sceneStateColors(theme)[state]
}

/** Theme the document shows. Read by the draw loop only, once per frame (a test enforces it). */
export function sceneTheme(): ThemeId {
  return currentThemeId()
}
