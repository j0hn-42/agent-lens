// Test helper (#476): make window.matchMedia report a phone-width viewport for the mobile query only.
// jsdom has no layout, so the setup stub answers `matches: false` to every query (the desktop render).
import { act } from 'react'
import { MOBILE_QUERY } from '@/lib/mobile-view'

type Listener = () => void
const listeners = new Set<Listener>()
let mobile = false

const w = window as unknown as Record<string, unknown>
const original = w.matchMedia as (q: string) => MediaQueryList

w.matchMedia = (query: string) => {
  if (query !== MOBILE_QUERY) return original(query)
  return {
    get matches() { return mobile },
    media: query,
    onchange: null,
    addEventListener: (_: string, l: Listener) => { listeners.add(l) },
    removeEventListener: (_: string, l: Listener) => { listeners.delete(l) },
    addListener: (l: Listener) => { listeners.add(l) },
    removeListener: (l: Listener) => { listeners.delete(l) },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList
}
;(globalThis as Record<string, unknown>).matchMedia = w.matchMedia

/** Switch the mobile query on or off and tell its listeners (as a resize across 768 px would). */
export function setMobileView(on: boolean): void {
  if (on === mobile) return
  mobile = on
  act(() => { for (const l of [...listeners]) l() })
}
