/**
 * Real, focusable <button>s laid over the canvas bubbles anchored on the edges (issue #41). The canvas
 * paints the bubble; the button gives it keyboard and assistive-tech access: it has an accessible name
 * (sender, receiver, kind, first words) and Enter / Space / click open the link panel. Buttons are
 * created, moved and removed imperatively each frame (no React state per frame), and are reused by key
 * so a focused bubble keeps its focus. Pure DOM, no React: testable under jsdom.
 */

export interface BubbleButtonSpec {
  key: string
  linkId: string
  messageId: string
  label: string
  /** Screen px, relative to the layer */
  x: number
  y: number
  w: number
  h: number
  /** Collapsed to a count chip */
  collapsed: boolean
}

export interface BubbleLayerHandlers {
  onOpen: (linkId: string) => void
  /** Hovered / focused message ids change: the bubbles they name never expire */
  onHoldChange?: (heldMessageIds: ReadonlySet<string>) => void
}

/** Controls are never smaller than this (px) */
export const MIN_BUBBLE_TARGET_PX = 24

interface LayerState {
  buttons: Map<string, HTMLButtonElement>
  hovered: string | null
  focused: string | null
  handlers: BubbleLayerHandlers
  dispose: () => void
}

const states = new WeakMap<HTMLElement, LayerState>()

function heldSet(st: LayerState, root: HTMLElement): Set<string> {
  const out = new Set<string>()
  for (const id of [st.hovered, st.focused]) if (id) out.add(id)
  void root
  return out
}

/** Attach delegated listeners to the layer. Returns a disposer. Calling it again replaces the handlers. */
export function attachBubbleLayer(root: HTMLElement, handlers: BubbleLayerHandlers): () => void {
  const existing = states.get(root)
  if (existing) { existing.handlers = handlers; return existing.dispose }

  const st: LayerState = { buttons: new Map(), hovered: null, focused: null, handlers, dispose: () => {} }
  const buttonOf = (t: EventTarget | null): HTMLButtonElement | null =>
    t instanceof Element ? t.closest<HTMLButtonElement>('button[data-edge-bubble]') : null
  const notify = () => st.handlers.onHoldChange?.(heldSet(st, root))

  const onClick = (e: Event) => {
    const b = buttonOf(e.target)
    if (b?.dataset.linkId) st.handlers.onOpen(b.dataset.linkId)
  }
  const onOver = (e: Event) => {
    const b = buttonOf(e.target)
    if (b && st.hovered !== (b.dataset.messageId ?? null)) { st.hovered = b.dataset.messageId ?? null; notify() }
  }
  const onOut = (e: Event) => {
    if (buttonOf(e.target) && st.hovered !== null) { st.hovered = null; notify() }
  }
  const onFocusIn = (e: Event) => {
    const b = buttonOf(e.target)
    if (b) { st.focused = b.dataset.messageId ?? null; notify() }
  }
  const onFocusOut = (e: Event) => {
    if (buttonOf(e.target) && st.focused !== null) { st.focused = null; notify() }
  }
  root.addEventListener('click', onClick)
  root.addEventListener('pointerover', onOver)
  root.addEventListener('pointerout', onOut)
  root.addEventListener('focusin', onFocusIn)
  root.addEventListener('focusout', onFocusOut)
  st.dispose = () => {
    root.removeEventListener('click', onClick)
    root.removeEventListener('pointerover', onOver)
    root.removeEventListener('pointerout', onOut)
    root.removeEventListener('focusin', onFocusIn)
    root.removeEventListener('focusout', onFocusOut)
    for (const b of st.buttons.values()) b.remove()
    st.buttons.clear()
    states.delete(root)
  }
  states.set(root, st)
  return st.dispose
}

/**
 * Make the layer show exactly `specs`: new buttons are created, existing ones moved, the others removed.
 * The focused button is never removed (the canvas holds its bubble while it has focus): it is only hidden
 * visually when its bubble is not placed, so keyboard focus is not lost mid-frame.
 */
export function syncBubbleButtons(root: HTMLElement, specs: readonly BubbleButtonSpec[]): void {
  let st = states.get(root)
  if (!st) { attachBubbleLayer(root, { onOpen: () => {} }); st = states.get(root)! }
  const doc = root.ownerDocument
  const seen = new Set<string>()
  for (const spec of specs) {
    seen.add(spec.key)
    let b = st.buttons.get(spec.key)
    if (!b) {
      b = doc.createElement('button')
      b.type = 'button'
      b.setAttribute('data-edge-bubble', '')
      b.className = 'edge-bubble-button'
      b.style.position = 'absolute'
      b.style.left = '0'
      b.style.top = '0'
      b.style.padding = '0'
      b.style.margin = '0'
      b.style.border = '0'
      b.style.background = 'transparent'
      b.style.color = 'transparent'
      b.style.cursor = 'pointer'
      b.style.pointerEvents = 'auto'
      b.style.borderRadius = '5px'
      b.dataset.linkId = spec.linkId
      b.dataset.messageId = spec.messageId
      root.appendChild(b)
      st.buttons.set(spec.key, b)
    }
    if (b.getAttribute('aria-label') !== spec.label) b.setAttribute('aria-label', spec.label)
    b.dataset.collapsed = spec.collapsed ? 'true' : 'false'
    const w = Math.max(MIN_BUBBLE_TARGET_PX, Math.round(spec.w))
    const h = Math.max(MIN_BUBBLE_TARGET_PX, Math.round(spec.h))
    b.style.width = `${w}px`
    b.style.height = `${h}px`
    b.style.transform = `translate(${Math.round(spec.x)}px, ${Math.round(spec.y)}px)`
    b.style.visibility = 'visible'
    b.tabIndex = 0
  }
  const active = doc.activeElement
  for (const [key, b] of st.buttons) {
    if (seen.has(key)) continue
    if (b === active) {
      // Keep focus: park the button out of sight until the bubble is placed again
      b.style.visibility = 'hidden'
      continue
    }
    b.remove()
    st.buttons.delete(key)
  }
}

/** Number of buttons currently in the layer (tests, memory bound). */
export function bubbleButtonCount(root: HTMLElement): number {
  return states.get(root)?.buttons.size ?? 0
}
