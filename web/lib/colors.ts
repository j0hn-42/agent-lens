/**
 * Color palette and role color definitions.
 *
 * Two palettes, one rule: the theme (neon | graphite | paper) applies to the INTERFACE ONLY.
 *
 * - COLORS is the interface palette (toolbar, menus, dialogs, side panels, legend, inspector, UI cards). It
 *   follows the active theme. Callers read `COLORS.<key>` at render time. The values are concrete colour
 *   strings, rebuilt from the `--lens-<role>` custom properties computed on :root (getComputedStyle) by
 *   `refreshColors()` whenever the theme changes (see lib/theme.ts). Read COLORS when you render, never cache
 *   a value at module load: it would go stale on a theme switch.
 * - SCENE is the scene palette: the page background and everything drawn on the canvas (nodes, links, halos,
 *   phase zones, particles, bloom, bubbles and tool cards, canvas labels, grid). It is the neon palette,
 *   frozen: the scene looks the same whatever theme is chosen. Never make SCENE depend on the theme.
 *
 * Extracted from agent-types.ts to keep that file focused on type definitions.
 * All colors are re-exported from agent-types.ts for backward compatibility.
 */

import type { AgentState, ContextBreakdown } from './agent-types'
import { currentThemeId, readTokens } from './theme-dom'
import { NEON_COLORS, paletteFor, type ColorKey, type Palette } from './theme-palette'
import { DEFAULT_THEME, type ThemeId } from './theme-tokens'

export type { ColorKey } from './theme-palette'

/**
 * Live palette (mutated in place by refreshColors so imports stay valid). It starts on the default theme so the
 * first client render of a server-rendered page matches the server markup; `syncColors()` (called by the theme
 * hooks of lib/theme.ts before any component paints) moves it to the theme the document actually shows.
 */
export const COLORS: { -readonly [K in ColorKey]: string } = paletteFor(DEFAULT_THEME)

/** Scene palette: the neon colours the canvas and the page background have always used, whatever the theme. */
export const SCENE: Readonly<Palette> = Object.freeze({ ...NEON_COLORS })

/**
 * Interface colour of a state colour that the simulation stored as data (timeline blocks carry the scene colour they
 * were created with). The timeline lives in a side panel, so it paints the theme's equivalent role; a colour that is
 * not one of these roles is returned as is.
 */
const STATE_KEYS = ['idle', 'thinking', 'tool', 'mcp', 'waiting_permission', 'error', 'complete', 'dispatch', 'return'] as const
export function uiColor(sceneColor: string): string {
  const key = STATE_KEYS.find(k => SCENE[k] === sceneColor)
  return key ? COLORS[key] : sceneColor
}

/** Theme COLORS is currently built for */
let paletteTheme: ThemeId = DEFAULT_THEME

/** Rebuild COLORS for a theme (default: the one the document shows). Returns COLORS. */
export function refreshColors(id: ThemeId = currentThemeId()): typeof COLORS {
  Object.assign(COLORS, paletteFor(id, readTokens(id)))
  paletteTheme = id
  return COLORS
}

/** Rebuild COLORS only when the document shows another theme than the one it was built for. */
export function syncColors(): void {
  const id = currentThemeId()
  if (id !== paletteTheme) refreshColors(id)
}

/**
 * A lookup table of colours that follows the theme: `themed(() => ({ ... COLORS.x ... }))` rebuilds the
 * table on each read, so a module-level table never goes stale after a theme switch.
 */
export function themed<T extends object>(factory: () => T): T {
  return new Proxy({} as T, {
    get: (_t, key) => Reflect.get(factory(), key),
    has: (_t, key) => Reflect.has(factory(), key),
    ownKeys: () => Reflect.ownKeys(factory()),
    getOwnPropertyDescriptor: (_t, key) => {
      const d = Reflect.getOwnPropertyDescriptor(factory(), key)
      return d ? { ...d, configurable: true } : undefined
    },
  })
}

// ─── Role Colors (message feed & bubbles) ───────────────────────────────────

type RoleColor = { bg: string; bgSelected: string; text: string; label: string }

/** Getters, not snapshots: the colours follow the theme every time a role is read. */
export const ROLE_COLORS: Record<string, RoleColor> = {
  get assistant(): RoleColor { return { bg: COLORS.roleAssistantBg, bgSelected: COLORS.roleAssistantBgSelected, text: COLORS.roleAssistantText, label: 'CLAUDE' } },
  get thinking(): RoleColor { return { bg: COLORS.roleThinkingBg, bgSelected: COLORS.roleThinkingBgSelected, text: COLORS.roleThinkingText, label: 'THINKING' } },
  get user(): RoleColor { return { bg: COLORS.roleUserBg, bgSelected: COLORS.roleUserBgSelected, text: COLORS.roleUserText, label: 'USER' } },
}

// ─── Color Helper Functions ──────────────────────────────────────────────────

/** State colour in a palette: the interface (default, follows the theme) or the scene (canvas callers pass SCENE). */
export function getStateColor(state: AgentState, palette: Readonly<Palette> = COLORS): string {
  switch (state) {
    case 'idle': return palette.idle
    case 'thinking': return palette.thinking
    case 'tool_calling': return palette.tool_calling
    case 'complete': return palette.complete
    case 'error': return palette.error
    case 'paused': return palette.paused
    case 'waiting_permission': return palette.waiting_permission
  }
}

export function getDiscoveryTypeColor(type: string, palette: Readonly<Palette> = COLORS): string {
  switch (type) {
    case 'file': return palette.discoveryFile
    case 'pattern': return palette.discoveryPattern
    case 'finding': return palette.discoveryFinding
    default: return palette.discoveryCode
  }
}

/** Safely combine a partial rgba base (e.g. 'rgba(10, 15, 30,') with an alpha value */
export function withAlpha(rgbaBase: string, alpha: number): string {
  return `${rgbaBase} ${alpha})`
}

/** Build the context-breakdown color segments for a given breakdown. */
export function contextSegments(bd: ContextBreakdown, palette: Readonly<Palette> = COLORS) {
  return [
    { value: bd.systemPrompt, color: palette.contextSystem },
    { value: bd.userMessages, color: palette.contextUser },
    { value: bd.toolResults, color: palette.contextToolResults },
    { value: bd.reasoning, color: palette.contextReasoning },
    { value: bd.subagentResults, color: palette.contextSubagent },
  ]
}
