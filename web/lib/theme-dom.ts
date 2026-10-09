/**
 * DOM side of the theme: which theme the document shows and what its tokens resolve to.
 * The canvas 2D context does not understand var(), so the palette is rebuilt from the values the
 * browser computed for the `--lens-<role>` custom properties on :root (getComputedStyle).
 * Without a DOM (node tests, SSR) everything falls back to the static token table.
 */

import { DEFAULT_THEME, ROLES, TOKENS, cssVar, isThemeId, type ThemeId, type ThemeTokens } from './theme-tokens'

/** localStorage key of the chosen theme. Mirrors THEME_STORAGE_KEY of extension/src/theme-bootstrap.ts (a test compares them). */
export const THEME_STORAGE_KEY = 'agent-lens-theme'

function rootElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement
}

/** Theme the document currently shows (data-theme set by the bootstrap script), the default theme (catppuccin-macchiato) when unset. */
export function currentThemeId(): ThemeId {
  const attr = rootElement()?.dataset?.theme
  return isThemeId(attr) ? attr : DEFAULT_THEME
}

/** Token values of a theme as the browser computes them on :root; any missing or malformed value falls back to the table. */
export function readTokens(id: ThemeId = currentThemeId()): ThemeTokens {
  const out = { ...TOKENS[id] }
  const root = rootElement()
  if (!root || typeof getComputedStyle !== 'function') return out
  let style: CSSStyleDeclaration
  try { style = getComputedStyle(root) } catch { return out }
  // Only trust the live values when the document really shows this theme
  if (currentThemeId() !== id) return out
  for (const role of ROLES) {
    const value = style.getPropertyValue(cssVar(role)).trim()
    if (/^#[0-9a-f]{6}$/i.test(value)) out[role] = value
  }
  return out
}

/** Make the document show a theme: data-theme, the `dark` class and color-scheme (every theme is dark). */
export function applyThemeToDocument(id: ThemeId): void {
  const root = rootElement()
  if (!root) return
  root.classList.add('dark')
  root.dataset.theme = id
  root.style.colorScheme = 'dark'
}
