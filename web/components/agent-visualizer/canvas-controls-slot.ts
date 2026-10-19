'use client'

import { useSyncExternalStore } from 'react'
import { CONTROL_BAR_BOTTOM, DOCK_GAP } from '@/lib/panel-layout'
import { TOUCH_TARGET_PX } from '@/lib/mobile-view'

/** Height of a row of controls: 44 px targets under 768 px (#476, MOBILE_QUERY in lib/mobile-view), 24 px buttons and their border wider */
const CONTROL_ROW_PX = { touch: TOUCH_TARGET_PX, pointer: 28 } as const
const TOUCH_BELOW_PX = 768
/** Under the `sm:` breakpoint of the canvas controls the Legend row and the zoom row stack */
const STACK_BELOW_PX = 640

/**
 * Whether the canvas controls fit in the room the top bar (--topbar-h) and the playback bar leave (#515). At 320 x 256
 * the bars leave 18 px and at 256 x 320 38 px, less than the two rows of 44 px targets: the controls were drawn under
 * the top bar.
 */
export function canvasControlsFit(env: { viewport: { w: number; h: number }; topbarH: number; controlBarH: number }, extraRow = false): boolean {
  const { viewport: { w, h }, topbarH, controlBarH } = env
  const row = w < TOUCH_BELOW_PX ? CONTROL_ROW_PX.touch : CONTROL_ROW_PX.pointer
  // `extraRow`: the "N names hidden" button is shown (#594); under the stacking width it may wrap above the zoom row
  const rows = w < STACK_BELOW_PX ? (extraRow ? 3 : 2) : 1
  const need = rows * row + (rows - 1) * DOCK_GAP
  return h - CONTROL_BAR_BOTTOM - controlBarH - DOCK_GAP - topbarH >= need
}

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
