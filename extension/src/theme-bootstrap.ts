/**
 * Inline theme bootstrap shared by every HTML shell (webview, standalone app, dev server layout).
 * It runs before the bundle so the first paint already has the right theme (no flash).
 * Themes: 'catppuccin-macchiato' | 'catppuccin-mocha' | 'catppuccin-frappe' | 'midnight' | 'graphite' | 'neon' | 'ember' | 'anthropic' | 'contrast', all dark (the `dark` class and
 * `color-scheme: dark` are always set). Resolution order: stored choice, `?theme=` parameter, then the
 * default (catppuccin-macchiato). Anything else is ignored. Values stored by earlier versions still work and resolve to the
 * default: 'dark', 'light' and the removed 'paper' -> catppuccin-macchiato (a stored valid theme id is kept). The system or host (VS Code) light mode never
 * switches the theme.
 * Kept as ES5 text so it can be inlined (with a CSP nonce where one is required) or served as /theme.js and unit-tested in a vm.
 */

export const THEME_STORAGE_KEY = 'agent-lens-theme'

export const THEME_IDS = ['catppuccin-macchiato', 'catppuccin-mocha', 'catppuccin-frappe', 'midnight', 'graphite', 'neon', 'ember', 'anthropic', 'contrast'] as const
export type ThemeId = (typeof THEME_IDS)[number]

/** Theme shown when nothing is stored and no `?theme=` is given. Mirrored by DEFAULT_THEME of web/lib/theme-tokens.ts (a test compares them). */
export const DEFAULT_THEME: ThemeId = 'catppuccin-macchiato'

/** Stored or URL values of earlier versions that resolve to DEFAULT_THEME. Mirrored by LEGACY_THEME_IDS of web/lib/theme-tokens.ts (a test compares them). */
export const LEGACY_THEME_IDS: readonly string[] = ['dark', 'light', 'paper']

export function themeBootstrapScript(): string {
  return `(function () {
  var root = document.documentElement;
  var IDS = ${JSON.stringify(THEME_IDS)};
  var LEGACY = ${JSON.stringify(LEGACY_THEME_IDS)};
  function valid(v) {
    if (IDS.indexOf(v) !== -1) return v;
    if (LEGACY.indexOf(v) !== -1) return ${JSON.stringify(DEFAULT_THEME)};
    return null;
  }
  function explicit() {
    var t = null;
    try { t = valid(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})); } catch (e) {}
    if (t) return t;
    try { t = valid(new URLSearchParams(location.search).get('theme')); } catch (e) {}
    return t;
  }
  var t = explicit() || ${JSON.stringify(DEFAULT_THEME)};
  root.classList.add('dark');
  root.dataset.theme = t;
  root.style.colorScheme = 'dark';
})();`
}
