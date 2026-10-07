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
  /** Hovered / focused bubbles change: the bubbles they name never expire. Message ids, and bubble keys (`linkId|messageId`). */
  onHoldChange?: (heldMessageIds: ReadonlySet<string>, heldKeys: ReadonlySet<string>) => void
  /**
   * Element (the canvas) that receives the wheel and the drags that start on a bubble button, so zoom and
   * pan keep working when the pointer is over a bubble. Without it the events stay on the button.
   */
  forwardTarget?: () => HTMLElement | null
}

/** Pointer travel (px) after which a press on a bubble becomes a pan of the canvas rather than a click */
export const DRAG_FORWARD_PX = 4

/** Controls are never smaller than this (px) */
export const MIN_BUBBLE_TARGET_PX = 24

interface PressState { pointerId: number; x: number; y: number; forwarding: boolean }

interface LayerState {
  buttons: Map<string, HTMLButtonElement>
  /** Keys of the hovered / focused bubble buttons */
  hovered: string | null
  focused: string | null
  press: PressState | null
  suppressClick: boolean
  handlers: BubbleLayerHandlers
  dispose: () => void
}

const states = new WeakMap<HTMLElement, LayerState>()

/** Message ids and bubble keys of the hovered / focused buttons. */
function heldSets(st: LayerState): { ids: Set<string>; keys: Set<string> } {
  const ids = new Set<string>()
  const keys = new Set<string>()
  for (const key of [st.hovered, st.focused]) {
    if (!key) continue
    keys.add(key)
    const id = st.buttons.get(key)?.dataset.messageId
    if (id) ids.add(id)
  }
  return { ids, keys }
}

type EventCtor = new (type: string, init?: Record<string, unknown>) => Event

/** Clone a pointer / wheel event onto another element (the canvas). */
function forwardEvent(e: MouseEvent | WheelEvent, type: string, target: HTMLElement, at?: { x: number; y: number }): void {
  const win = target.ownerDocument.defaultView as (Window & Record<string, unknown>) | null
  if (!win) return
  const isWheel = type === 'wheel'
  const Ctor = ((isWheel ? win.WheelEvent : win.PointerEvent) ?? win.MouseEvent) as EventCtor
  const pe = e as PointerEvent
  const we = e as WheelEvent
  target.dispatchEvent(new Ctor(type, {
    bubbles: true, cancelable: true, composed: true,
    clientX: at?.x ?? e.clientX, clientY: at?.y ?? e.clientY, screenX: e.screenX, screenY: e.screenY,
    button: e.button, buttons: e.buttons, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey,
    pointerId: pe.pointerId, pointerType: pe.pointerType, isPrimary: pe.isPrimary,
    deltaX: we.deltaX, deltaY: we.deltaY, deltaZ: we.deltaZ, deltaMode: we.deltaMode,
  }))
}

/** Attach delegated listeners to the layer. Returns a disposer. Calling it again replaces the handlers. */
export function attachBubbleLayer(root: HTMLElement, handlers: BubbleLayerHandlers): () => void {
  const existing = states.get(root)
  if (existing) { existing.handlers = handlers; return existing.dispose }

  const st: LayerState = {
    buttons: new Map(), hovered: null, focused: null, press: null, suppressClick: false, handlers, dispose: () => {},
  }
  const buttonOf = (t: EventTarget | null): HTMLButtonElement | null =>
    t instanceof Element ? t.closest<HTMLButtonElement>('button[data-edge-bubble]') : null
  const keyOf = (b: HTMLButtonElement): string | null => b.dataset.key ?? null
  const notify = () => {
    const { ids, keys } = heldSets(st)
    st.handlers.onHoldChange?.(ids, keys)
  }
  const target = () => st.handlers.forwardTarget?.() ?? null

  const onClick = (e: Event) => {
    if (st.suppressClick) { st.suppressClick = false; e.stopPropagation(); e.preventDefault(); return }
    const b = buttonOf(e.target)
    if (b?.dataset.linkId) st.handlers.onOpen(b.dataset.linkId)
  }
  const onOver = (e: Event) => {
    const b = buttonOf(e.target)
    const key = b ? keyOf(b) : null
    if (b && st.hovered !== key) { st.hovered = key; notify() }
  }
  const onOut = (e: Event) => {
    if (buttonOf(e.target) && st.hovered !== null) { st.hovered = null; notify() }
  }
  const onFocusIn = (e: Event) => {
    const b = buttonOf(e.target)
    if (b) { st.focused = keyOf(b); notify() }
  }
  const onFocusOut = (e: Event) => {
    if (buttonOf(e.target) && st.focused !== null) { st.focused = null; notify() }
  }

  // Wheel over a bubble zooms / pans the canvas
  const onWheel = (e: Event) => {
    const to = target()
    if (!to || !buttonOf(e.target)) return
    e.preventDefault()
    forwardEvent(e as WheelEvent, 'wheel', to)
  }
  // A press that travels more than DRAG_FORWARD_PX is a pan: replay it on the canvas; a short press stays a click
  const onPointerDown = (e: Event) => {
    const pe = e as PointerEvent
    st.suppressClick = false
    if (!buttonOf(e.target) || (pe.pointerType === 'mouse' && pe.button !== 0)) return
    st.press = { pointerId: pe.pointerId, x: pe.clientX, y: pe.clientY, forwarding: false }
  }
  const onPointerMove = (e: Event) => {
    const pe = e as PointerEvent
    const press = st.press
    const to = target()
    if (!press || !to || press.pointerId !== pe.pointerId) return
    if (!press.forwarding) {
      if (Math.hypot(pe.clientX - press.x, pe.clientY - press.y) < DRAG_FORWARD_PX) return
      press.forwarding = true
      st.suppressClick = true
      forwardEvent(pe, 'pointerdown', to, { x: press.x, y: press.y })
    }
    forwardEvent(pe, 'pointermove', to)
  }
  const onPointerEnd = (e: Event) => {
    const pe = e as PointerEvent
    const press = st.press
    if (!press || press.pointerId !== pe.pointerId) return
    st.press = null
    const to = target()
    if (press.forwarding && to) forwardEvent(pe, e.type === 'pointercancel' ? 'pointercancel' : 'pointerup', to)
  }

  const listeners: Array<[string, (e: Event) => void, AddEventListenerOptions?]> = [
    ['click', onClick, { capture: true }],
    ['pointerover', onOver], ['pointerout', onOut],
    ['focusin', onFocusIn], ['focusout', onFocusOut],
    ['wheel', onWheel, { passive: false }],
    ['pointerdown', onPointerDown], ['pointermove', onPointerMove],
    ['pointerup', onPointerEnd], ['pointercancel', onPointerEnd],
  ]
  for (const [type, fn, opts] of listeners) root.addEventListener(type, fn, opts)
  st.dispose = () => {
    for (const [type, fn, opts] of listeners) root.removeEventListener(type, fn, opts)
    for (const b of st.buttons.values()) b.remove()
    st.buttons.clear()
    states.delete(root)
  }
  states.set(root, st)
  return st.dispose
}

/**
 * Make the layer show exactly `specs`: new buttons are created, existing ones moved, the others removed.
 * The focused button is never removed (the canvas holds its bubble while it has focus): when its bubble
 * is not placed it stays where it was, transparent and inert (never display:none / visibility:hidden,
 * which would blur it), so keyboard focus is not lost mid-frame. A hovered button that goes away clears
 * the hover (the browser sends no pointerout for a removed element).
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
      b.style.touchAction = 'none'
      b.dataset.key = spec.key
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
    b.style.opacity = ''
    b.style.pointerEvents = 'auto'
    delete b.dataset.unplaced
    b.tabIndex = 0
  }
  const active = doc.activeElement
  let holdChanged = false
  for (const [key, b] of st.buttons) {
    if (seen.has(key)) continue
    if (b === active) {
      // Keep focus: leave the button in place, invisible and inert, until the bubble is placed again
      b.style.opacity = '0'
      b.style.pointerEvents = 'none'
      b.dataset.unplaced = 'true'
      if (st.hovered === key) { st.hovered = null; holdChanged = true }
      continue
    }
    if (st.hovered === key) { st.hovered = null; holdChanged = true }
    if (st.focused === key) { st.focused = null; holdChanged = true }
    if (st.press) st.press = null
    b.remove()
    st.buttons.delete(key)
  }
  if (holdChanged) st.handlers.onHoldChange?.(heldSets(st).ids, heldSets(st).keys)
}

/** Number of buttons currently in the layer (tests, memory bound). */
export function bubbleButtonCount(root: HTMLElement): number {
  return states.get(root)?.buttons.size ?? 0
}
