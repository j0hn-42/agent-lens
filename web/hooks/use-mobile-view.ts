'use client'

import { useSyncExternalStore } from 'react'
import { MOBILE_QUERY, TOPBAR_FOLD_QUERY, TOPBAR_NARROW_QUERY, topbarTier, type TopbarTier } from '@/lib/mobile-view'

const mobileList = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY) : null)

/** Subscribe to crossings of the mobile breakpoint (768 px). */
function subscribeMobileView(onChange: () => void): () => void {
  const mql = mobileList()
  mql?.addEventListener('change', onChange)
  return () => mql?.removeEventListener('change', onChange)
}

/** True below 768 px wide (#476). */
const isMobileView = (): boolean => mobileList()?.matches ?? false

/** True below 768 px wide; false on the server and where matchMedia is missing (the desktop render). */
export function useMobileView(): boolean {
  return useSyncExternalStore(subscribeMobileView, isMobileView, () => false)
}

const foldList = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(TOPBAR_FOLD_QUERY) : null)

/** True below 1024 px wide: the panel buttons of the top bar are behind More; the other mobile branches start under 768 px. */
const isTopbarFolded = (): boolean => foldList()?.matches ?? false

const narrowList = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(TOPBAR_NARROW_QUERY) : null)

/** Subscribe to crossings of any width where the top bar changes what it draws (768, 1024 and 1280 px). */
export function subscribeTopbarTier(onChange: () => void): () => void {
  const lists = [mobileList(), foldList(), narrowList()]
  for (const mql of lists) mql?.addEventListener('change', onChange)
  return () => { for (const mql of lists) mql?.removeEventListener('change', onChange) }
}

/** What the top bar draws at the current width; 'wide' on the server and where matchMedia is missing. */
export const getTopbarTier = (): TopbarTier => topbarTier(isMobileView(), isTopbarFolded(), narrowList()?.matches ?? false)
