// Test helper (#476, #523): make window.matchMedia report a viewport width for the queries of the chrome (mobile view
// under 768 px, the widths of the one-line top bar at 1024 and 1280 px). jsdom has no layout, so the setup stub answers
// `matches: false` to every other query (the desktop render).
import { act } from 'react'
import { MOBILE_QUERY, TOPBAR_FOLD_QUERY, TOPBAR_NARROW_QUERY } from '@/lib/mobile-view'

type Listener = () => void
const QUERIES = [MOBILE_QUERY, TOPBAR_FOLD_QUERY, TOPBAR_NARROW_QUERY]
const listeners = new Map<string, Set<Listener>>(QUERIES.map(q => [q, new Set<Listener>()]))
/** The wide default: none of the queries matches */
const WIDE = 1440
let width = WIDE

const maxWidth = (query: string) => Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1] ?? Infinity)
const matches = (query: string, w: number) => w <= maxWidth(query)

const w = window as unknown as Record<string, unknown>
const original = w.matchMedia as (q: string) => MediaQueryList

w.matchMedia = (query: string) => {
  const set = listeners.get(query)
  if (!set) return original(query)
  return {
    get matches() { return matches(query, width) },
    media: query,
    onchange: null,
    addEventListener: (_: string, l: Listener) => { set.add(l) },
    removeEventListener: (_: string, l: Listener) => { set.delete(l) },
    addListener: (l: Listener) => { set.add(l) },
    removeListener: (l: Listener) => { set.delete(l) },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList
}
;(globalThis as Record<string, unknown>).matchMedia = w.matchMedia

/** Report a viewport `next` px wide and tell the listeners of each query it crosses (as a resize would). */
export function setViewportWidth(next: number): void {
  if (next === width) return
  const crossed = QUERIES.filter(q => matches(q, width) !== matches(q, next))
  width = next
  act(() => { for (const q of crossed) for (const l of [...listeners.get(q)!]) l() })
}

/** Switch the mobile query on (a 375 px phone, also under the fold width) or off (the wide default). */
export function setMobileView(on: boolean): void {
  setViewportWidth(on ? 375 : WIDE)
}
