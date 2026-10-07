/** Selector for everything the browser may put in the Tab order. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex^="-"]), [contenteditable="true"]'

/**
 * Runs inside the page (Playwright serialises it, so it must stay self-contained).
 * Returns a description of every Tab-order element that is not visible: zero size,
 * `display:none`, `visibility:hidden`, or inside an `aria-hidden`/`inert` subtree.
 */
export function findInvisibleFocusables(selector: string): string[] {
  const out: string[] = []
  document.querySelectorAll<HTMLElement>(selector).forEach(el => {
    if (el.tabIndex < 0) return
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const hiddenByTree = !!el.closest('[aria-hidden="true"], [inert]')
    const invisible = r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none'
    if (invisible || hiddenByTree) {
      out.push(`${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20) ?? ''}]`)
    }
  })
  return out
}
