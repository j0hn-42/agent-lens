'use client'

import { useSyncExternalStore } from 'react'
import { MOBILE_QUERY } from '@/lib/mobile-view'

const mobileList = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null)

/** Subscribe to crossings of the mobile breakpoint (768 px). */
export function subscribeMobileView(onChange: () => void): () => void {
  const mql = mobileList()
  mql?.addEventListener('change', onChange)
  return () => mql?.removeEventListener('change', onChange)
}

/** True below 768 px wide (#476). */
export const isMobileView = (): boolean => mobileList()?.matches ?? false

/** True below 768 px wide; false on the server and where matchMedia is missing (the desktop render). */
export function useMobileView(): boolean {
  return useSyncExternalStore(subscribeMobileView, isMobileView, () => false)
}
