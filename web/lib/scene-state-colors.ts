/**
 * Colours of the canvas scene in a theme (#381): the agent state colours, and the rest of the scene (labels, links, halos,
 * cards, grid).
 *
 * - The state of an agent (the ring, glow, centre icon, scan line, orbiting particles and waiting ripples of its node, the
 *   state word under its name, the scene glow behind the active agent, the legend's swatch) is painted with the colour the
 *   panels give that state in the theme, so one state has one colour on every surface.
 * - The rest of the scene reads `scenePalette(theme)`: Neon keeps the literal scene palette it has always drawn (SCENE in
 *   lib/colors.ts, pinned by scripts/scene-neon.test.ts); every other theme draws with its own token palette (`paletteFor`),
 *   on the scene ground. The ground itself (`void`, the page background behind the canvas) stays the neon void in every
 *   theme (globals.css --scene-void): only what is drawn on it follows the theme.
 * - High contrast also sets a floor (`SCENE_FLOOR`): a text drawn on the scene reaches 7:1 on the ground and a non-text mark
 *   3:1. `sceneInk` raises the alpha of a translucent colour until it does, and falls back to the theme's ink when even the
 *   opaque colour cannot (an identity colour such as a model tier). The other themes have no floor: they paint their tokens
 *   as given.
 *
 * The theme is explicit: callers pass it. The draw loop reads the active theme on every frame with `sceneTheme()` and hands
 * it to the draw functions in their options; the legend takes it from `useTheme()`. No theme given (a test, an old caller)
 * means the neon scene. Built from the static token table, the same values the generated themes.css gives the panels.
 * Pure apart from `sceneTheme()` (which reads data-theme on the document, the default theme without a DOM).
 */

import type { AgentState } from './agent-types'
import { NEON_COLORS, paletteFor, type Palette } from './theme-palette'
import { currentThemeId } from './theme-dom'
import type { ThemeId } from './theme-tokens'

type StateColors = Readonly<Record<AgentState, string>>

const cache = new Map<ThemeId, StateColors>()

/** The seven agent state colours of a theme (cached: the draw loop asks for them every frame). */
function sceneStateColors(theme: ThemeId): StateColors {
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

/** Theme the document shows. Read by the draw loop only, on every frame (a test enforces it). */
export function sceneTheme(): ThemeId {
  return currentThemeId()
}

// ─── The rest of the scene ───────────────────────────────────────────────────

/** The neon scene palette, the one SCENE (lib/colors.ts) holds: what Neon and a call without a theme draw. */
const NEON_SCENE: Readonly<Palette> = Object.freeze({ ...NEON_COLORS })

/** Colours of the scene in one theme (a palette: the canvas code reads it through this module only) */
export type ScenePalette = Readonly<Palette>

const palettes = new Map<ThemeId, ScenePalette>()

/**
 * Colours of the scene (everything but the agent states) in a theme: the neon scene palette for Neon or no theme, the
 * theme's token palette otherwise, with the scene ground (`void`) kept. Cached: the draw functions read it every frame.
 */
export function scenePalette(theme?: ThemeId): ScenePalette {
  if (!theme || theme === 'neon') return NEON_SCENE
  let p = palettes.get(theme)
  if (!p) {
    p = Object.freeze({ ...paletteFor(theme), void: NEON_SCENE.void })
    palettes.set(theme, p)
  }
  return p
}

/** Minimum contrast on the scene ground of a text and of a non-text mark, per theme. Absent: the theme paints its tokens as given. */
const SCENE_FLOOR: Readonly<Partial<Record<ThemeId, { readonly text: number; readonly mark: number }>>> = Object.freeze({
  contrast: Object.freeze({ text: 7, mark: 3 }),
})

type Rgb = readonly [number, number, number]
/** [r, g, b, a] of '#rrggbb', '#rrggbbaa' or 'rgb(a)(r, g, b[, a])' */
function parseColor(color: string): [number, number, number, number] {
  const v = color.trim()
  if (v.startsWith('#')) {
    const n = (i: number) => parseInt(v.slice(i, i + 2), 16)
    return [n(1), n(3), n(5), v.length === 9 ? n(7) / 255 : 1]
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v)
  if (!m) throw new Error(`sceneInk: unparseable colour ${color}`)
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
}
const lum = (c: Rgb) => {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}
const mixRgb = (fg: Rgb, bg: Rgb, a: number): Rgb => [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)) as unknown as Rgb
const ratio = (a: Rgb, b: Rgb) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, '0')
const overRgb = (color: string, bg: Rgb): Rgb => { const [r, g, b, a] = parseColor(color); return mixRgb([r, g, b], bg, a) }

/** What a scene text or mark can sit on: the scene ground, and the lightest plate drawn on it (a selected card). */
const groundCache = new Map<ThemeId, readonly Rgb[]>()
function sceneGrounds(theme: ThemeId): readonly Rgb[] {
  let grounds = groundCache.get(theme)
  if (!grounds) {
    const p = scenePalette(theme)
    const ground = overRgb(p.void, [0, 0, 0])
    grounds = [ground, overRgb(p.cardBgSelected, ground), overRgb(p.cardBg, ground), overRgb(p.cardBgDark, ground)]
    groundCache.set(theme, grounds)
  }
  return grounds
}

/**
 * Colour and alpha to paint `color` with in `theme`, as a text or a non-text mark, drawn under the global alpha `alpha`.
 * Without a floor: `color` and `alpha`, unchanged. With one: an opaque '#rrggbb' and the alpha it is painted at (its own
 * alpha times `alpha`), raised by steps of 1/255 until it reaches the floor on the scene ground and on the plates drawn on it
 * (cards, label plates); a colour that cannot reach it even opaque becomes the theme's ink, opaque.
 */
export function sceneInk(theme: ThemeId | undefined, kind: 'text' | 'mark', color: string, alpha = 1): { color: string; alpha: number } {
  const floor = theme ? SCENE_FLOOR[theme] : undefined
  if (!floor) return { color, alpha }
  const min = floor[kind]
  const grounds = sceneGrounds(theme!)
  const [r, g, b, own] = parseColor(color)
  const fg: Rgb = [r, g, b]
  const reaches = (a: number) => grounds.every(gr => ratio(mixRgb(fg, gr, a), gr) >= min)
  if (!reaches(1)) return { color: scenePalette(theme).ink, alpha: 1 }
  let a = Math.max(0, Math.min(1, own * alpha))
  while (a < 1 && !reaches(a)) a = Math.min(1, (Math.round(a * 255) + 1) / 255)
  return { color: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha: a }
}

/**
 * `color` + `alphaSuffix` (a two-digit hex alpha, the form the draw code appends to a '#rrggbb'), legible in `theme`
 * (sceneInk), for a paint drawn under the global alpha `under` (a card faded in, 1 by default): the alpha it needs goes into
 * the colour. Neon and the themes without a floor get exactly `color + alphaSuffix`.
 */
export function sceneColor(theme: ThemeId | undefined, kind: 'text' | 'mark', color: string, alphaSuffix = '', under = 1): string {
  if (!theme || !SCENE_FLOOR[theme]) return color + alphaSuffix
  // Quantised down (never above the real one) so a fading global alpha keeps the cache bounded (256 steps)
  const u = Math.max(1, Math.floor(under * 255 + 1e-9)) / 255
  const key = `${theme}|${kind}|${color}|${alphaSuffix}|${u}`
  let out = colorCache.get(key)
  if (out === undefined) {
    const ink = sceneInk(theme, kind, color + alphaSuffix, u)
    const own = Math.min(1, ink.alpha / u)
    // Rounded up: the alpha that went into the colour must not fall back under the floor
    out = own >= 1 ? ink.color : ink.color + hex2(Math.min(255, Math.ceil(own * 255 - 1e-9)))
    colorCache.set(key, out)
  }
  return out
}
/** sceneColor results of the themes with a floor (the draw loop asks for the same few colours every frame) */
const colorCache = new Map<string, string>()
