/**
 * Burrow view: the content of the name tag under an animal. When a loop is proven for its agent (the rule of the graph's
 * loop badge, repeatMarks), a badge follows the name: the circular arrow of the graph's badge and the agent card's words
 * (*Loop observed*), so the badge does not depend on its colour. The tag is aria-hidden: the agent list row says it.
 * The badge takes the theme's colours (warning border, raised surface, ink), not the picture's paper.
 */

/** Fills `el` with the name and, when `loop` is given, the badge; does nothing when the content and size are unchanged */
export function fillTag(el: HTMLElement, name: string, loop: string | null, u: number): void {
  const want = `${name}\u0000${loop ?? ''}\u0000${u}`
  if (el.dataset.content === want) return
  el.dataset.content = want
  el.replaceChildren(document.createTextNode(name))
  if (loop === null) return
  const badge = document.createElement('span')
  badge.dataset.burrowLoop = ''
  const s = badge.style
  s.display = 'inline-block'
  s.marginInlineStart = `${u}px`
  s.padding = `0 ${u * 0.75}px`
  s.background = 'var(--lens-surface-raised)'
  s.color = 'var(--lens-ink)'
  s.border = `${Math.max(1, u / 2)}px solid var(--lens-warn)`
  s.borderRadius = `${u}px`
  s.lineHeight = '1.2'
  badge.textContent = `↻ ${loop}`
  el.appendChild(badge)
}
