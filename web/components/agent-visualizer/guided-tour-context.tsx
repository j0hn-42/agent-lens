'use client'

import { createContext, useContext, type MutableRefObject } from 'react'
import type { LegendPresence } from '@/lib/legend-presence'

export interface TourBridge {
  /** The guided tour wants the graph legend open (the saved preference is left alone) */
  legendOpen: boolean
  /** Filled by the canvas: world point to client coordinates (the tour ring follows agents) */
  canvasToScreenRef: MutableRefObject<((worldX: number, worldY: number) => { x: number; y: number }) | null>
  /** The legend keeps every entry (the guided demo steps talk about symbols the demo does not draw) */
  legendShowAll?: boolean
  /** Set when a tour can be started (tour not running): the legend shows this button beside its own */
  startTour?: () => void
  /** Name of that button: "Guided tour" (demo, the default) or "Tour this session" (real session) */
  startTourLabel?: string
  /** Filled by the canvas with what its scene proves on screen (the legend and the live tour read it) */
  reportPresence?: (presence: LegendPresence) => void
}

/** Id of the "Guided tour" button: the focus lands on it when the tour ends and what opened the tour is gone */
export const GUIDED_TOUR_BUTTON_ID = 'guided-tour-start'

/**
 * Id of the "Canvas controls" button (#515): when the canvas controls are folded into the playback bar, the Guided tour
 * button exists only while that button's block is open, and the tour closes the block. That button stands for it then.
 */
export const CANVAS_CONTROLS_MENU_ID = 'canvas-controls-menu'

/** Where the focus goes back to the guided tour: its button, or the folded "Canvas controls" button that holds it */
export const guidedTourButton = (): HTMLElement | null =>
  document.getElementById(GUIDED_TOUR_BUTTON_ID) ?? document.getElementById(CANVAS_CONTROLS_MENU_ID)

export const TourBridgeContext = createContext<TourBridge>({ legendOpen: false, canvasToScreenRef: { current: null } })
export const useTourBridge = () => useContext(TourBridgeContext)
