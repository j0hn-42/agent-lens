'use client'

import { useSyncExternalStore } from 'react'

/**
 * Place in the playback bar where the canvas controls fold when they do not fit between the top bar and the playback
 * bar (#515: at 320 x 256 the two bars leave 18 px, less than one 44 px target). The control bar renders the slot
 * (live and review bars both do), the canvas controls portal their single "Canvas controls" button into it.
 */
let slot: HTMLElement | null = null
const listeners = new Set<() => void>()
const notify = () => { for (const l of listeners) l() }

/** Callback ref of the slot element (React 19 ref cleanup) */
export function canvasControlsSlotRef(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined
  slot = el
  notify()
  return () => {
    if (slot !== el) return
    slot = null
    notify()
  }
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

export function useCanvasControlsSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null)
}
