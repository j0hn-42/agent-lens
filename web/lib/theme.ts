/**
 * Theme store: the active theme, its persistence and the re-render signal.
 *
 * `setTheme` makes the document show the theme (data-theme, `dark` class, color-scheme), stores the choice
 * under THEME_STORAGE_KEY (the same key the inline bootstrap script reads before first paint), rebuilds
 * COLORS from the computed `--lens-*` properties (canvas) and notifies subscribers (React).
 */

import { useSyncExternalStore } from 'react'
import { refreshColors, syncColors } from './colors'
import { THEME_STORAGE_KEY, applyThemeToDocument, currentThemeId } from './theme-dom'
import { DEFAULT_THEME, isThemeId, type ThemeId } from './theme-tokens'

export { THEME_STORAGE_KEY }

const listeners = new Set<() => void>()

/** Theme the document shows. */
export function getTheme(): ThemeId {
  syncColors() // COLORS must match the theme before any component paints with it
  return currentThemeId()
}

/** Switch theme: validates the id, persists it (best effort), updates the document, COLORS and subscribers. */
export function setTheme(id: ThemeId): void {
  if (!isThemeId(id)) return
  try { window.localStorage.setItem(THEME_STORAGE_KEY, id) } catch { /* private mode / blocked storage: the choice just lasts for this page */ }
  applyThemeToDocument(id)
  refreshColors(id)
  for (const cb of Array.from(listeners)) cb()
}

export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * Active theme and its setter. Components that paint with COLORS re-render when it changes
 * (the hook is what makes the theme switch visible in React-rendered inline styles).
 */
export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const id = useSyncExternalStore(subscribeTheme, getTheme, () => DEFAULT_THEME)
  return [id, setTheme]
}

/** Re-render on theme change without reading the id (for components that only paint with COLORS). */
export function useThemeVersion(): ThemeId {
  return useSyncExternalStore(subscribeTheme, getTheme, () => DEFAULT_THEME)
}
