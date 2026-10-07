/**
 * Inline theme bootstrap shared by every HTML shell (webview, dev iframe host, standalone app).
 * It runs before the bundle so the first paint already has the right theme (no flash), then keeps
 * following the host. Resolution order: stored choice, `?theme=` parameter, host mode (VS Code body
 * class), system preference. Anything that is not exactly 'light' or 'dark' is ignored.
 * Kept as ES5 text so it can be inlined (with a CSP nonce where one is required) and unit-tested in a vm.
 */

export const THEME_STORAGE_KEY = 'agent-lens-theme'

export function themeBootstrapScript(): string {
  return `(function () {
  var root = document.documentElement;
  function valid(v) { return v === 'light' || v === 'dark' ? v : null; }
  function explicit() {
    var t = null;
    try { t = valid(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})); } catch (e) {}
    if (t) return t;
    try { t = valid(new URLSearchParams(location.search).get('theme')); } catch (e) {}
    return t;
  }
  function host() {
    var b = document.body;
    if (!b) return null;
    var s = (b.className || '') + ' ' + (b.getAttribute('data-vscode-theme-kind') || '');
    if (/vscode-(high-contrast-)?light/.test(s)) return 'light';
    if (/vscode-(high-contrast|dark)/.test(s)) return 'dark';
    return null;
  }
  function system() {
    try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'dark'; }
  }
  function apply() {
    var t = explicit() || host() || system();
    root.classList.toggle('dark', t === 'dark');
    root.dataset.theme = t;
    root.style.colorScheme = t;
  }
  apply();
  if (document.body && typeof MutationObserver === 'function') {
    new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-kind'] });
  }
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply); } catch (e) {}
})();`
}
