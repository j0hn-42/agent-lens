// Preload for the a11y tests: installs a jsdom window as globals so that
// React DOM and @testing-library/react can run under node:test.
// jsdom has no layout engine, so color contrast is NOT checked here
// (see scripts/contrast.test.ts for the token-level contrast checks).
import { JSDOM } from 'jsdom'
import { act } from 'react'

const dom = new JSDOM('<!doctype html><html lang="en"><head><title>a11y</title></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom

const g = globalThis as unknown as Record<string, unknown>
const copy = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'HTMLCanvasElement', 'Element', 'Node', 'NodeFilter', 'Event', 'KeyboardEvent', 'MouseEvent',
  'FocusEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'DocumentFragment',
  'SVGElement', 'Text', 'HTMLDivElement', 'HTMLSpanElement',
] as const
g.window = window
for (const k of copy) {
  if (k === 'window') continue
  try {
    Object.defineProperty(globalThis, k, { value: (window as never)[k], configurable: true, writable: true })
  } catch {
    // some globals (e.g. navigator) are getters on Node; defineProperty above handles them
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true
// Run frame callbacks inside act() so state updates they trigger do not warn.
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => { act(() => { cb(Date.now()) }) }, 0)
g.cancelAnimationFrame = (id: number) => clearTimeout(id)

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
g.ResizeObserver = NoopObserver
g.IntersectionObserver = NoopObserver
;(window as never as Record<string, unknown>).ResizeObserver = NoopObserver
;(window as never as Record<string, unknown>).matchMedia = (query: string) => ({
  matches: false, media: query, onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
})
g.matchMedia = (window as never as Record<string, unknown>).matchMedia

// Canvas: return a context whose methods are all no-ops.
const noopCtx = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'measureText') return () => ({ width: 0 })
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} })
    return () => {}
  },
  set: () => true,
})
window.HTMLCanvasElement.prototype.getContext = (() => noopCtx) as never
window.HTMLElement.prototype.scrollIntoView = () => {}
