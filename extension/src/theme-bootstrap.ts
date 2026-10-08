/**
 * Inline theme bootstrap shared by every HTML shell (webview, standalone app, dev server layout).
 * It runs before the bundle so the first paint already has the right theme (no flash).
 * Themes: 'neon' | 'graphite' | 'paper'. Resolution order: stored choice, `?theme=` parameter, then the
 * default (graphite). Anything else is ignored. Values stored by earlier versions still work:
 * 'dark' -> graphite, 'light' -> paper.
 * neon and graphite are dark (the `dark` class stays), paper is light; `color-scheme` follows.
 * Kept as ES5 text so it can be inlined (with a CSP nonce where one is required) or served as /theme.js and unit-tested in a vm.
 */

export const THEME_STORAGE_KEY = 'agent-lens-theme'

export const THEME_IDS = ['neon', 'graphite', 'paper'] as const
export type ThemeId = (typeof THEME_IDS)[number]

/** Theme shown when nothing is stored and no `?theme=` is given. Mirrored by DEFAULT_THEME of web/lib/theme-tokens.ts (a test compares them). */
export const DEFAULT_THEME: ThemeId = 'graphite'

/** Themes drawn on a dark ground: they keep the `dark` class. */
export const LIGHT_THEMES: readonly ThemeId[] = ['paper']

export function themeBootstrapScript(): string {
  return `(function () {
  var root = document.documentElement;
  var LIGHT = ${JSON.stringify(LIGHT_THEMES)};
  function valid(v) {
    if (v === 'neon' || v === 'graphite' || v === 'paper') return v;
    if (v === 'dark') return 'graphite';
    if (v === 'light') return 'paper';
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
  var light = LIGHT.indexOf(t) !== -1;
  root.classList.toggle('dark', !light);
  root.dataset.theme = t;
  root.style.colorScheme = light ? 'light' : 'dark';
})();`
}
