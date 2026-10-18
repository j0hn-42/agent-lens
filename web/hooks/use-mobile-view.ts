'use client'

import { useSyncExternalStore } from 'react'
import { MOBILE_QUERY, TOPBAR_FOLD_QUERY } from '@/lib/mobile-view'

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

const foldList = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(TOPBAR_FOLD_QUERY) : null)

/** Subscribe to crossings of the top bar fold (1024 px, #523). */
export function subscribeTopbarFold(onChange: () => void): () => void {
  const mql = foldList()
  mql?.addEventListener('change', onChange)
  return () => mql?.removeEventListener('change', onChange)
}

/** True below 1024 px wide: the top bar folds behind More (#523); the other mobile branches start under 768 px. */
export const isTopbarFolded = (): boolean => foldList()?.matches ?? false
