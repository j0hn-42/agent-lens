/**
 * Color palette and role color definitions.
 *
 * COLORS follows the active theme (neon | graphite | paper). Its API is unchanged: callers read
 * `COLORS.<key>` at draw/render time. The canvas 2D context does not understand var(), so the values are
 * concrete colour strings, rebuilt from the `--lens-<role>` custom properties computed on :root
 * (getComputedStyle) by `refreshColors()` whenever the theme changes (see lib/theme.ts). Read COLORS when
 * you draw or render, never cache a value at module load: it would go stale on a theme switch.
 *
 * Extracted from agent-types.ts to keep that file focused on type definitions.
 * All colors are re-exported from agent-types.ts for backward compatibility.
 */

import type { AgentState, ContextBreakdown } from './agent-types'
import { currentThemeId, readTokens } from './theme-dom'
import { paletteFor, type ColorKey } from './theme-palette'
import { DEFAULT_THEME, type ThemeId } from './theme-tokens'

export type { ColorKey } from './theme-palette'

/**
 * Live palette (mutated in place by refreshColors so imports stay valid). It starts on the default theme so the
 * first client render of a server-rendered page matches the server markup; `syncColors()` (called by the theme
 * hooks of lib/theme.ts before any component paints) moves it to the theme the document actually shows.
 */
export const COLORS: { -readonly [K in ColorKey]: string } = paletteFor(DEFAULT_THEME)

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

export function getStateColor(state: AgentState): string {
  switch (state) {
    case 'idle': return COLORS.idle
    case 'thinking': return COLORS.thinking
    case 'tool_calling': return COLORS.tool_calling
    case 'complete': return COLORS.complete
    case 'error': return COLORS.error
    case 'paused': return COLORS.paused
    case 'waiting_permission': return COLORS.waiting_permission
  }
}

export function getDiscoveryTypeColor(type: string): string {
  switch (type) {
    case 'file': return COLORS.discoveryFile
    case 'pattern': return COLORS.discoveryPattern
    case 'finding': return COLORS.discoveryFinding
    default: return COLORS.discoveryCode
  }
}

/** Safely combine a partial rgba base (e.g. 'rgba(10, 15, 30,') with an alpha value */
export function withAlpha(rgbaBase: string, alpha: number): string {
  return `${rgbaBase} ${alpha})`
}

/** Build the context-breakdown color segments for a given breakdown. */
export function contextSegments(bd: ContextBreakdown) {
  return [
    { value: bd.systemPrompt, color: COLORS.contextSystem },
    { value: bd.userMessages, color: COLORS.contextUser },
    { value: bd.toolResults, color: COLORS.contextToolResults },
    { value: bd.reasoning, color: COLORS.contextReasoning },
    { value: bd.subagentResults, color: COLORS.contextSubagent },
  ]
}
